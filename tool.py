"""Native Windows item spawner UI. Start daemon.py before launching this file."""
import json
import queue
import threading
import tkinter as tk
from tkinter import ttk

from jsc import call


SLOT_LABELS = {"Weapon": "武器", "Utility": "工具", "Backpack": "背包", "Heavy": "重物"}
FULL_POLICIES = {"拒绝生成": "reject", "多余道具刷到地上": "ground"}
CATEGORIES = {"全部可生成模板": None, "拾取道具": "pickup", "货舱物品 / 舰船部件": "cargo"}


def rpc(method, *args):
    response = call(method, list(args))
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "工具请求失败"))
    result = response.get("result")
    return json.loads(result) if isinstance(result, str) else result


class ItemTool:
    def __init__(self, root):
        self.root = root
        self.root.title("Jump Space 道具工具")
        self.root.geometry("1040x760")
        self.root.minsize(860, 640)
        self.queue = queue.Queue()
        self.busy = False
        self.players = []
        self.items = []
        self.player_id = None
        self.item_by_row = {}
        self.controls = []
        self.search = tk.StringVar()
        self.category = tk.StringVar(value="全部可生成模板")
        self.destination = tk.StringVar(value="backpack")
        self.quantity = tk.StringVar(value="1")
        self.full_policy = tk.StringVar(value="拒绝生成")
        self.status = tk.StringVar(value="连接中…")
        self.inventory_text = tk.StringVar(value="请选择目标角色，再查看背包。")
        self.item_text = tk.StringVar(value="请选择道具。数量按独立道具计算，每个道具预留一个背包空位。")
        self.build()
        self.search.trace_add("write", lambda *_: self.filter_items())
        self.category.trace_add("write", lambda *_: self.filter_items())
        self.root.after(100, self.poll)
        self.refresh()

    def build(self):
        frame = ttk.Frame(self.root, padding=16)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Jump Space · 道具工具", font=("Microsoft YaHei UI", 18, "bold")).pack(anchor="w")
        ttk.Label(frame, text="选角色 → 搜索道具 → 选择背包或地上", padding=(0, 4, 0, 12)).pack(anchor="w")
        player_row = ttk.Frame(frame)
        player_row.pack(fill="x")
        ttk.Label(player_row, text="目标角色").pack(side="left", padx=(0, 8))
        self.player_box = ttk.Combobox(player_row, state="readonly", width=48)
        self.player_box.pack(side="left", fill="x", expand=True)
        self.player_box.bind("<<ComboboxSelected>>", self.select_player)
        self.controls.append((self.player_box, "readonly"))
        refresh = ttk.Button(player_row, text="刷新角色与道具", command=self.refresh)
        refresh.pack(side="left", padx=(12, 0))
        self.controls.append((refresh, "normal"))
        ttk.Label(frame, textvariable=self.inventory_text, wraplength=970, padding=(0, 10)).pack(anchor="w", fill="x")
        search_row = ttk.Frame(frame)
        search_row.pack(fill="x", pady=(0, 8))
        ttk.Label(search_row, text="搜索道具").pack(side="left", padx=(0, 8))
        search = ttk.Entry(search_row, textvariable=self.search)
        search.pack(side="left", fill="x", expand=True)
        self.controls.append((search, "normal"))
        category = ttk.Combobox(search_row, textvariable=self.category, values=list(CATEGORIES), state="readonly", width=23)
        category.pack(side="left", padx=(10, 0))
        self.controls.append((category, "readonly"))
        self.count_label = ttk.Label(search_row, text="")
        self.count_label.pack(side="left", padx=(12, 0))
        table_frame = ttk.Frame(frame)
        table_frame.pack(fill="both", expand=True)
        self.table = ttk.Treeview(table_frame, columns=("display", "name", "slot", "bag"), show="headings", selectmode="browse")
        for name, title, width in [("display", "道具名称", 220), ("name", "资源名称", 410), ("slot", "类型", 85), ("bag", "可放背包", 85)]:
            self.table.heading(name, text=title)
            self.table.column(name, width=width, minwidth=70)
        self.table.pack(side="left", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(table_frame, orient="vertical", command=self.table.yview)
        scrollbar.pack(side="right", fill="y")
        self.table.configure(yscrollcommand=scrollbar.set)
        self.table.bind("<<TreeviewSelect>>", self.select_item)
        ttk.Label(frame, textvariable=self.item_text, wraplength=970, padding=(0, 10)).pack(fill="x")
        options = ttk.Frame(frame)
        options.pack(fill="x")
        for label, value in [("刷进背包", "backpack"), ("刷到目标附近地上", "ground")]:
            button = ttk.Radiobutton(options, text=label, variable=self.destination, value=value, command=self.update_policy_state)
            button.pack(side="left", padx=(0, 16))
            self.controls.append((button, "normal"))
        ttk.Label(options, text="数量").pack(side="left", padx=(10, 8))
        quantity = ttk.Spinbox(options, from_=1, to=30, textvariable=self.quantity, width=5)
        quantity.pack(side="left")
        self.controls.append((quantity, "normal"))
        ttk.Label(options, text="满包时").pack(side="left", padx=(20, 8))
        self.policy_box = ttk.Combobox(options, textvariable=self.full_policy, values=list(FULL_POLICIES), state="readonly", width=20)
        self.policy_box.pack(side="left")
        self.controls.append((self.policy_box, "readonly"))
        actions = ttk.Frame(frame)
        actions.pack(fill="x", pady=(12, 8))
        for label, command in [("检查能否生成", self.preview), ("生成道具", self.spawn), ("查看背包", self.read_inventory), ("设计图 / 蓝图", self.read_blueprints)]:
            button = ttk.Button(actions, text=label, command=command)
            button.pack(side="left", padx=(0, 12))
            self.controls.append((button, "normal"))
        ttk.Label(frame, textvariable=self.status, wraplength=970).pack(anchor="w", fill="x")
        self.log = tk.Text(frame, height=5, state="disabled", wrap="word", font=("Microsoft YaHei UI", 9))
        self.log.pack(fill="x", pady=(8, 0))

    def set_busy(self, busy):
        self.busy = busy
        for widget, state in self.controls:
            widget.configure(state="disabled" if busy else state)
        self.update_policy_state()

    def update_policy_state(self):
        self.policy_box.configure(state="disabled" if self.busy or self.destination.get() == "ground" else "readonly")

    def run(self, task, complete):
        if self.busy:
            return
        self.set_busy(True)

        def worker():
            try:
                self.queue.put((complete, task(), None))
            except Exception as error:
                self.queue.put((complete, None, str(error)))

        threading.Thread(target=worker, daemon=True).start()

    def poll(self):
        try:
            complete, result, error = self.queue.get_nowait()
        except queue.Empty:
            pass
        else:
            self.set_busy(False)
            if error:
                self.report("请求失败：" + error + "。请确认游戏和 daemon.py 已启动。")
            else:
                try:
                    complete(result)
                except Exception as error:
                    self.report("显示结果失败：" + str(error))
        self.root.after(100, self.poll)

    def report(self, text):
        self.status.set(text)
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def refresh(self):
        if self.busy:
            return
        self.status.set("正在读取角色和道具…")

        def complete(result):
            roster, catalog = result
            self.items = catalog["items"]
            self.players = roster["players"]
            labels = [f'{p["name"]} · 客户端 {p["clientId"]}' + (" · 本机" if p["local"] else "") + (" · 倒地/死亡" if p["downed"] else "") for p in self.players]
            self.player_box.configure(values=labels)
            index = next((i for i, p in enumerate(self.players) if p["id"] == self.player_id), None)
            if index is None:
                self.player_box.set("")
                self.player_id = None
                self.inventory_text.set("请选择目标角色。角色离线或重生后必须重新选择。")
            else:
                self.player_box.current(index)
            self.filter_items()
            state = roster["network"]
            if not state["listening"]:
                self.report("尚未进入游戏会话。进入游戏后点击刷新。")
            elif not state["server"]:
                self.report("当前是联机客户端，请在房主电脑运行工具进行生成。")
            else:
                counts = catalog["counts"]
                self.report(f'已连接房主会话：{len(self.players)} 个角色。资源目录：拾取模板 {counts["pickup"]}，货舱模板 {counts["cargo"]}（部件 {counts["shipComponents"]}），属性模块配置 {counts["modules"]}。可生成模板 {len(self.items)}。')
            if catalog["failures"]:
                self.report("部分模板加载失败：" + "；".join(x["message"] for x in catalog["failures"]))

        self.run(lambda: (rpc("players"), rpc("fullCatalog")), complete)

    def filter_items(self):
        selected = self.selected_item()
        selected_name = selected["name"] if selected else None
        self.table.delete(*self.table.get_children())
        self.item_by_row.clear()
        query = self.search.get().strip().casefold()
        category = CATEGORIES[self.category.get()]
        for item in self.items:
            if category and item["category"] != category:
                continue
            if query and query not in (item["name"] + " " + item["display"]).casefold():
                continue
            slot = "货舱" if item["category"] == "cargo" else SLOT_LABELS.get(item["slot"], item["slot"])
            row = self.table.insert("", "end", values=(item["display"], item["name"], slot, "是" if item["canBackpack"] else "否"))
            self.item_by_row[row] = item
            if item["name"] == selected_name:
                self.table.selection_set(row)
        self.count_label.configure(text=f"{len(self.item_by_row)} / {len(self.items)}")
        self.select_item()

    def selected_item(self):
        rows = self.table.selection()
        return self.item_by_row.get(rows[0]) if rows else None

    def select_item(self, _event=None):
        item = self.selected_item()
        if not item:
            self.item_text.set("请选择道具。数量按独立道具计算，每个道具预留一个背包空位。")
            return
        self.item_text.set(f'{item["display"]} · 堆叠上限 {item["maxStack"]} · ' + ("可放背包" if item["canBackpack"] else "只能刷到地上") + "。每个生成道具预留一个空位，不自动合并已有堆叠。")

    def select_player(self, _event=None):
        index = self.player_box.current()
        self.player_id = self.players[index]["id"] if index >= 0 else None
        self.read_inventory()

    def read_inventory(self):
        if not self.player_id:
            self.report("请先选择目标角色。")
            return
        selector = self.player_id
        self.run(lambda: rpc("inv", selector), self.show_inventory)

    def show_inventory(self, inventory):
        bag = inventory["slotInfo"]["Backpack"]
        entries = inventory["entries"]["Backpack"]
        names = [f'{i + 1}: {e["display"]} ×{e["stack"]}' for i, e in enumerate(entries) if e]
        self.inventory_text.set(f'背包 {bag["count"]}/{bag["capacity"]} · 空位 {sum(e is None for e in entries)}' + (" · " + "；".join(names) if names else " · 空背包"))

    def arguments(self):
        if not self.player_id:
            self.report("请先选择目标角色。")
            return None
        item = self.selected_item()
        if not item:
            self.report("请先选择道具。")
            return None
        try:
            count = int(self.quantity.get())
            if not 1 <= count <= 30:
                raise ValueError()
        except ValueError:
            self.report("数量必须是 1–30 的整数。")
            return None
        return (item["name"], count, self.destination.get(), self.player_id, FULL_POLICIES[self.full_policy.get()])

    def preview(self):
        args = self.arguments()
        if args:
            def complete(result):
                if not result["ok"]:
                    self.report(result["error"]["message"])
                else:
                    self.report(f'目标：{result["player"]["name"]}；计划放入背包 {result["backpack"]} 个，地上 {result["ground"]} 个。')
            self.run(lambda: rpc("previewSpawn", *args), complete)

    def read_blueprints(self):
        def complete(data):
            self.report(f'已读取本机玩家 {data["player"]["name"]} 的蓝图：已保存 {len(data["owned"])}，历史 {len(data["history"])}。')
            window = tk.Toplevel(self.root)
            window.title("设计图 / 蓝图 · " + data["player"]["name"])
            window.geometry("920x560")
            ttk.Label(window, text="操作本机玩家存档：在“发现历史”保存装备蓝图，在“资源目录”解锁配方或添加拥有舰船。会保存到当前游戏存档。", wraplength=850, padding=12).pack(fill="x")
            tabs = ttk.Notebook(window)
            tabs.pack(fill="both", expand=True, padx=12, pady=(0, 12))
            for title, rows in [("已保存蓝图", data["owned"]), ("发现历史", data["history"]), ("已解锁制作配方", data["unlockedCraftables"]), ("已解锁舰船蓝图", data["unlockedShips"]), ("蓝图槽位", data["capacities"]), ("资源目录", data["definitions"])]:
                frame = ttk.Frame(tabs)
                tabs.add(frame, text=f"{title} ({len(rows)})")
                columns = ("name", "category", "rarity", "level", "detail")
                table = ttk.Treeview(frame, columns=columns, show="headings", selectmode="browse")
                for key, label, width in zip(columns, ("名称", "类别", "品质", "等级", "模块 / 槽位"), (300, 180, 100, 60, 220)):
                    table.heading(key, text=label)
                    table.column(key, width=width)
                table.pack(fill="both", expand=True)
                by_row = {}
                for row in rows:
                    detail = f'{len(row["modules"])} 个模块' if "modules" in row else (f'容量 {row["max"]}，已购 {row["purchased"]}' if "max" in row else "")
                    if row.get("kind") in ("craftable", "shipBlueprint"):
                        detail = ("已拥有" if row["kind"] == "shipBlueprint" else "已解锁") if row["unlocked"] else "未解锁"
                    iid = table.insert("", "end", values=(row.get("display") or row.get("name") or row.get("category", ""), row.get("category", ""), row.get("rarity", ""), row.get("level", ""), detail))
                    by_row[iid] = row
                if title in ("发现历史", "资源目录"):
                    actions = ttk.Frame(frame, padding=8)
                    actions.pack(fill="x")
                    method = "addBlueprint" if title == "发现历史" else "unlockBlueprint"
                    label = "保存选中历史为蓝图" if title == "发现历史" else "解锁选中配方 / 舰船"
                    for prefix, button_label in [("preview", "检查能否操作"), ("", label)]:
                        rpc_method = prefix + method[0].upper() + method[1:] if prefix else method
                        ttk.Button(actions, text=button_label, command=lambda t=table, r=by_row, m=rpc_method: self.blueprint_action(window, t, r, m, data["player"]["id"])).pack(side="left", padx=(0, 12))
        self.run(lambda: rpc("blueprints"), complete)

    def blueprint_action(self, window, table, rows, method, selector):
        if self.busy:
            return
        selection = table.selection()
        if not selection:
            self.report("请先选择一项历史装备或制作配方。")
            return
        row = rows[selection[0]]
        if "Unlock" in method or method == "unlockBlueprint":
            if row.get("kind") == "shipBlueprint":
                method = "previewUnlockShip" if method.startswith("preview") else "unlockShip"
            elif row.get("kind") != "craftable":
                self.report("请选择制作配方或舰船设计。")
                return
            source = row["key"]
        else:
            source = row["instanceGuid"]
        self.status.set("正在检查设计图…" if method.startswith("preview") else "正在更新本机设计图存档…")

        def complete(result):
            if not result["ok"]:
                self.report(result["error"]["message"])
                return
            if method.startswith("preview"):
                self.report("检查通过：已解锁/保存/拥有。" if result.get("alreadyUnlocked") or result.get("alreadySaved") or result.get("alreadyOwned") else "检查通过，可以操作。")
                return
            self.report("已更新本机设计图存档。" if result.get("changed") else "这项设计图已解锁或已保存，无需重复添加。")
            if window.winfo_exists():
                window.destroy()
            self.read_blueprints()

        self.run(lambda: rpc(method, source, selector), complete)

    def spawn(self):
        args = self.arguments()
        if not args:
            return
        self.status.set("正在生成并等待游戏确认，请稍候…")

        def task():
            result = rpc("spawn", *args)
            try:
                inventory = rpc("inv", args[3])
            except Exception:
                inventory = None
            return result, inventory

        def complete(data):
            result, inventory = data
            target = result.get("player", {}).get("name", "所选角色")
            text = f'{target}：已确认背包 {result["backpack"]} 个，地上 {result["ground"]} 个。'
            if not result["ok"]:
                text += " " + result["error"]["message"]
                if result.get("uncertain"):
                    text += " 仍有未确认结果，请先检查游戏，避免重复生成。"
            self.report(text)
            if inventory:
                self.show_inventory(inventory)

        self.run(task, complete)


if __name__ == "__main__":
    window = tk.Tk()
    ItemTool(window)
    window.mainloop()

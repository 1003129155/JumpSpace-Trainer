"""Local web UI server for the Jump Space trainer.

Serves ui/ and a small JSON API on 127.0.0.1 only. Every API call needs the
random per-run token (sent as X-JB-Token) and a localhost Host header, so other
web pages or programs cannot drive the game through this port. Only an explicit
allowlist of agent methods is reachable; arbitrary script evaluation is not.

Also keeps the operation history (with undo for currency edits) and makes a copy
of the save file before the first change of a session.
"""
import glob
import json
import mimetypes
import os
import secrets
import shutil
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jsc

import paths

ROOT = paths.SOURCE_DIR
UI_DIR = paths.resource_path("ui")
DATA_DIR = paths.app_path("data")
BACKUP_DIR = paths.app_path("backups")
HISTORY_FILE = os.path.join(DATA_DIR, "history.jsonl")
APP_ID = "1757300"
SAVE_NAME = "persistent_user_data.bin"

READ_METHODS = {
    "status", "progression", "cheats", "itemList", "itemInfo", "players", "inv", "recipes", "ships", "blueprints",
    "previewSpawn", "previewUnlockBlueprint", "previewUnlockShip", "previewAddBlueprint", "gearList", "gearEdit", "itemEdit",
    "ventures", "jumpMap",
}
WRITE_METHODS = {
    "setCurrency", "addCurrency", "addExperience", "levelUp", "setMateria", "addMateria", "setCheat", "setCheatParam", "cheatOnce",
    "spawn", "equipHand", "unlockRecipes", "unlockShips", "addBlueprint", "lockRecipes",
    "makeBlueprint", "removeRecipeBlueprints", "completeVenture", "jumpToNode", "completeMission",
}
# Changes to the profile (save file): back it up first.
PROFILE_WRITES = {
    "setCurrency", "addCurrency", "addExperience", "levelUp", "unlockRecipes", "unlockShips", "addBlueprint", "lockRecipes",
    "makeBlueprint", "removeRecipeBlueprints", "completeVenture", "completeMission",
}
ALLOWED = READ_METHODS | WRITE_METHODS


# ----------------------------------------------------------------------- save backup
def steam_root():
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            value, _ = winreg.QueryValueEx(key, "SteamPath")
        return os.path.normpath(value)
    except OSError:
        return None


def find_save_file():
    root = steam_root()
    if not root:
        return None
    files = glob.glob(os.path.join(root, "userdata", "*", APP_ID, "remote", SAVE_NAME))
    return max(files, key=os.path.getmtime) if files else None


class Backups:
    def __init__(self):
        self.lock = threading.Lock()
        self.last = 0.0

    def list(self):
        out = []
        for d in sorted(glob.glob(os.path.join(BACKUP_DIR, "*")), reverse=True):
            f = os.path.join(d, SAVE_NAME)
            if os.path.isfile(f):
                out.append({"name": os.path.basename(d), "size": os.path.getsize(f), "time": os.path.getmtime(f)})
        return out

    def make(self, reason="manual"):
        with self.lock:
            src = find_save_file()
            if not src:
                raise RuntimeError("找不到 Steam 存档文件（persistent_user_data.bin）")
            name = time.strftime("%Y%m%d-%H%M%S") + "_" + reason
            dst = os.path.join(BACKUP_DIR, name)
            os.makedirs(dst, exist_ok=True)
            shutil.copy2(src, os.path.join(dst, SAVE_NAME))
            self.last = time.time()
            for old in sorted(glob.glob(os.path.join(BACKUP_DIR, "*")))[:-30]:
                shutil.rmtree(old, ignore_errors=True)
            return {"name": name, "source": src, "size": os.path.getsize(os.path.join(dst, SAVE_NAME))}

    def ensure_recent(self, reason):
        # first profile change of a session, then at most one copy per 10 minutes
        if time.time() - self.last > 600:
            try:
                return self.make(reason)
            except Exception as e:  # noqa: BLE001  (never block the edit itself)
                return {"error": str(e)}
        return None


# ------------------------------------------------------------------------- history
class History:
    def __init__(self):
        self.lock = threading.Lock()
        self.items = []
        self.next_id = 1
        os.makedirs(DATA_DIR, exist_ok=True)
        try:
            undone = set()
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if "_undone" in row:
                        undone.add(row["_undone"])
                    else:
                        self.items.append(row)
            for row in self.items:
                if row.get("id") in undone:
                    row["undone"] = True
            self.items = self.items[-300:]
            self.next_id = max([x.get("id", 0) for x in self.items] + [0]) + 1
        except OSError:
            pass

    def add(self, entry):
        with self.lock:
            entry = {"id": self.next_id, "time": time.time(), **entry}
            self.next_id += 1
            self.items.append(entry)
            self.items = self.items[-300:]
            try:
                with open(HISTORY_FILE, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError:
                pass
            return entry

    def get(self, entry_id):
        with self.lock:
            return next((x for x in self.items if x["id"] == entry_id), None)

    def mark_undone(self, entry_id):
        with self.lock:
            for x in self.items:
                if x["id"] == entry_id:
                    x["undone"] = True
            try:
                with open(HISTORY_FILE, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"_undone": entry_id}) + "\n")
            except OSError:
                pass

    def recent(self, limit=100):
        with self.lock:
            return list(reversed(self.items[-limit:]))


def fmt(n):
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return str(n)


def blueprints_made(results):
    """What a request put into the game, in the form the undo needs: [{guid, where, level, rarity}].
    where = "slot" (a saved blueprint; level / rarity say how it looked when made) or "history" (an item in the discovery history)."""
    made = []
    for r in results:
        b = r.get("blueprint") or {}
        if not b.get("instanceGuid"):
            continue
        if b.get("status") == "saved":
            made.append({"guid": b["instanceGuid"], "where": "slot", "level": b.get("level"), "rarity": b.get("rarity")})
        elif b.get("status") == "found":
            made.append({"guid": b["instanceGuid"], "where": "history"})
    return made


TIERS = ["普通", "稀有", "史诗", "传说"]
TIER_NAMES = {"Common": 0, "Rare": 1, "Epic": 2, "Legendary": 3}


def tier_name(value):
    """'传说' for 3 or 'Legendary' (0..3 or the English name), '' when it is neither."""
    try:
        n = int(TIER_NAMES.get(value, value))
    except (TypeError, ValueError):
        return ""
    return TIERS[n] if 0 <= n < len(TIERS) else ""


def gear_text(gear):
    """'（传说品质 · 12 级 · 5 个词条）' for what an item was made with ({tier, level, modules}), '' without attributes."""
    if not isinstance(gear, dict):
        return ""
    parts = []
    if tier_name(gear.get("tier")):
        parts.append(tier_name(gear.get("tier")) + "品质")
    if gear.get("level"):
        parts.append(f"{gear['level']} 级")
    if gear.get("modules"):
        parts.append(f"{gear['modules']} 个词条")
    return "（" + " · ".join(parts) + "）" if parts else ""


def venture_rewards_text(venture):
    """'（经验 600 · 信用点 300 · 锭 5 · 打捞者头盔、冲击裤）' for what completing a venture gave, '' when it gave nothing listed."""
    parts = []
    for key, label in (("experience", "经验"), ("credits", "信用点"), ("ingots", "锭")):
        if venture.get(key):
            parts.append(f"{label} {fmt(venture[key])}")
    names = [u.get("name") for u in venture.get("unlocks", []) if u.get("name")]
    if names:
        parts.append("、".join(names))
    return "（" + " · ".join(parts) + "）" if parts else ""


class Gateway:
    """Calls the daemon, records history, protects the save file."""

    def __init__(self):
        self.history = History()
        self.backups = Backups()
        self.names = {}  # key/guid -> localized name, learned from list responses
        self.last_seen = 0.0

    # transport -----------------------------------------------------------------
    def raw(self, method, args, timeout=130):
        try:
            response = jsc.call(method, args, timeout=timeout)
        except (OSError, EOFError, TimeoutError) as e:
            return {"ok": False, "error": {"code": "NOT_CONNECTED", "message": f"无法连接守护进程：{e}。请确认修改器已启动，且游戏正在运行"}}
        if not response.get("ok"):
            code = response.get("code") or "BRIDGE_ERROR"
            return {"ok": False, "error": {"code": code, "message": response.get("error", "调用失败")}}
        result = response.get("result")
        if isinstance(result, str):
            try:
                parsed = json.loads(result)
                if isinstance(parsed, dict):
                    parsed.setdefault("ok", True)  # older agent calls return bare objects
                    return parsed
                return {"ok": True, "result": parsed}
            except ValueError:
                return {"ok": True, "result": result}
        if isinstance(result, dict):
            return {"ok": True, **result}
        return {"ok": True, "result": result}

    def bridge(self):
        r = self.raw("_bridge", [], timeout=5)
        if r.get("ok") and "result" in r:
            return {"ok": True, **r["result"]} if isinstance(r["result"], dict) else r
        return r

    # calls ---------------------------------------------------------------------
    def call(self, method, args):
        if method not in ALLOWED:
            return {"ok": False, "error": {"code": "FORBIDDEN", "message": f"不允许的命令：{method}"}}
        if not isinstance(args, list) or len(args) > 8:
            return {"ok": False, "error": {"code": "BAD_REQUEST", "message": "参数格式错误"}}
        backup = None
        if method in PROFILE_WRITES:
            backup = self.backups.ensure_recent("auto")
        result = self.raw(method, args)
        self.learn_names(method, result)
        entry = None
        if method in ("setCheatParam", "cheatOnce"):
            pass  # tuning a running cheat or a one-shot refill is not worth a history line
        elif method in WRITE_METHODS and method != "setCheat":
            entry = self.record(method, args, result)
        elif method == "setCheat" and result.get("ok"):
            entry = self.record(method, args, result)
        if entry:
            result["historyId"] = entry["id"]
            result["undoable"] = bool(entry.get("undo"))
        if backup and not backup.get("error"):
            result.setdefault("backup", backup["name"])
        return result

    def learn_names(self, method, result):
        if not result.get("ok"):
            return
        if method == "recipes":
            for r in result.get("recipes", []):
                self.names[r["key"]] = r["display"]
        elif method == "gearList":
            for r in result.get("gear", []):
                self.names[r["key"]] = r["display"]
        elif method == "ships":
            for s in result.get("ships", []):
                self.names[s["key"]] = s["display"]
        elif method == "itemList":
            for i in result.get("items", []):
                self.names[i["name"]] = i["display"]
        elif method == "ventures":
            for v in result.get("ventures", []):
                self.names[v["key"]] = v["name"]

    # history -------------------------------------------------------------------
    def record(self, method, args, result):
        ok = bool(result.get("ok"))
        entry = {"method": method, "ok": ok, "summary": "", "undo": None}
        if not ok:
            entry["summary"] = (result.get("error") or {}).get("message", "失败")
            entry["title"] = {"spawn": "刷出物品", "unlockRecipes": "解锁配方", "unlockShips": "解锁舰船", "makeBlueprint": "制作蓝图", "equipHand": "装备到手上"}.get(method, method)
            return self.history.add(entry)
        if method in ("setCurrency", "addCurrency"):
            cur, before, after = result["currency"], result["before"], result["after"]
            entry["title"] = f"{cur['display']}"
            entry["summary"] = f"{fmt(before)} → {fmt(after)}" + ("（已达上限/下限）" if result.get("clamped") else "")
            if result.get("changed"):
                # relative undo: later changes to the same currency are kept
                entry["undo"] = {"method": "addCurrency", "args": [cur["guid"], before - after]}
            else:
                return None  # nothing changed, nothing to log
        elif method in ("setMateria", "addMateria"):
            entry["title"] = "飞船物质"
            entry["summary"] = f"{result['before']['amount']} → {result['after']['amount']}"
            if result.get("changed"):
                entry["undo"] = {"method": "addMateria", "args": [result["before"]["amount"] - result["after"]["amount"]]}
            else:
                return None
        elif method == "addExperience":
            entry["title"] = "经验值"
            entry["summary"] = f"+{fmt(result['added'])}　Lv.{result['before']['level']} → Lv.{result['after']['level']}"
        elif method == "levelUp":
            entry["title"] = "提升等级"
            entry["summary"] = f"Lv.{result['before']['level']} → Lv.{result['after']['level']}"
        elif method in ("unlockRecipes", "unlockShips"):
            done = [r for r in result.get("results", []) if r.get("ok") and r.get("changed")]
            names = "、".join(self.names.get(r["key"], r["key"][:8]) for r in done)
            entry["title"] = "解锁配方" if method == "unlockRecipes" else "解锁舰船"
            entry["summary"] = names or "没有新增解锁"
            if result.get("failed"):
                entry["summary"] += f"（失败 {result['failed']} 项）"
            if not done and not result.get("failed"):
                return None
            if method == "unlockRecipes" and done:
                entry["undo"] = {"method": "lockRecipes", "args": [[r["key"] for r in done]]}
        elif method == "makeBlueprint":
            b = result.get("blueprint") or {}
            slot_mode = len(args) > 1 and args[1] == "slot"
            name = self.names.get(args[0], str(args[0])[:8]) if args else "?"
            entry["title"] = "存入蓝图槽" if slot_mode else "加入发现历史"
            entry["summary"] = name + gear_text({"tier": b.get("rarity"), "level": b.get("level")})
            made = blueprints_made([result])
            if made:
                entry["undo"] = {"method": "removeRecipeBlueprints", "args": [made]}
        elif method == "removeRecipeBlueprints":
            entry["title"] = "移除蓝图"
            entry["summary"] = f"已移除 {result.get('changed', 0)} 个"
        elif method == "completeVenture":
            if not result.get("changed"):
                return None  # it was done already
            v = result.get("venture") or {}
            entry["title"] = "完成委托"
            entry["summary"] = (v.get("name") or self.names.get(args[0] if args else "", "?")) + venture_rewards_text(v)
        elif method == "jumpToNode":
            entry["title"] = "跳跃到节点"
            entry["summary"] = (result.get("node") or {}).get("name") or "（未命名节点）"
        elif method == "completeMission":
            entry["title"] = "直接完成任务"
            entry["summary"] = "任务按完成结算"
        elif method == "lockRecipes":
            done = [r for r in result.get("results", []) if r.get("ok") and r.get("changed")]
            entry["title"] = "重新锁定配方"
            entry["summary"] = "、".join(self.names.get(r["key"], r["key"][:8]) for r in done) or "没有变化"
            gone = sum(1 for b in result.get("blueprints", []) if b.get("removed"))
            if gone:
                entry["summary"] += f"（并移除 {gone} 个蓝图）"
        elif method == "spawn":
            where = {"backpack": "背包", "ground": "地上"}
            item = result.get("item", args[0] if args else "?")
            entry["title"] = f"刷出 {self.names.get(item, item)}"
            entry["summary"] = f"背包 {result.get('backpack', 0)} 个，地上 {result.get('ground', 0)} 个" + gear_text(result.get("gear"))
        elif method == "equipHand":
            entry["title"] = "装备到手上"
            entry["summary"] = str(result.get("display", args[0] if args else "")) + gear_text(result.get("gear"))
        elif method == "setCheat":
            cheats = {c["name"]: c for c in result.get("cheats", [])}
            name = args[0] if args else ""
            on = cheats.get(name, {}).get("enabled")
            entry["title"] = cheats.get(name, {}).get("label", name)
            entry["summary"] = "已开启" if on else "已关闭"
            param = cheats.get(name, {}).get("param")
            if on and param:
                entry["summary"] += f"　{param['label']} {param['unit']}{round(param['value'], 2):g}"
        elif method == "addBlueprint":
            entry["title"] = "保存装备蓝图"
            entry["summary"] = "已保存"
        else:
            entry["title"] = method
        return self.history.add(entry)

    def undo(self, entry_id):
        entry = self.history.get(entry_id)
        if not entry or not entry.get("undo") or entry.get("undone"):
            return {"ok": False, "error": {"code": "NOT_UNDOABLE", "message": "这条记录无法撤销"}}
        spec = entry["undo"]
        result = self.raw(spec["method"], spec["args"])
        if result.get("ok"):
            self.history.mark_undone(entry_id)
            self.history.add({"method": "undo", "ok": True, "title": "撤销：" + entry.get("title", ""), "summary": "已恢复", "undo": None})
        return result


# --------------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "JumpSpaceTrainer/1.0"
    protocol_version = "HTTP/1.1"

    # set by create_server
    token = ""
    port = 0
    gateway = None
    on_shutdown = None

    def log_message(self, fmt_, *args):  # keep the console quiet
        pass

    # helpers -------------------------------------------------------------------
    def _host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        return host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}")

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
        )
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False))

    def _authorized(self):
        supplied = self.headers.get("X-JB-Token", "")
        ok = self._host_ok() and secrets.compare_digest(supplied.encode(), self.token.encode())
        if ok:
            self.gateway.last_seen = time.time()  # the open page polls constantly: proof the window is alive
        return ok

    # routes --------------------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, "forbidden", "text/plain; charset=utf-8")
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            if not self._authorized():
                return self._json(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "令牌无效，请重新打开修改器窗口"}})
            return self._api_get(path)
        if path in ("/", "/index.html"):
            query = urllib.parse.parse_qs(parsed.query)
            if not secrets.compare_digest((query.get("t", [""])[0]).encode(), self.token.encode()):
                return self._send(401, "请使用修改器启动器打开此页面（缺少访问令牌）", "text/plain; charset=utf-8")
            with open(os.path.join(UI_DIR, "index.html"), "r", encoding="utf-8") as f:
                html = f.read().replace("__JB_TOKEN__", self.token)
            return self._send(200, html, "text/html; charset=utf-8")
        return self._static(path)

    def _static(self, path):
        rel = urllib.parse.unquote(path).lstrip("/")
        full = os.path.realpath(os.path.join(UI_DIR, rel))
        if not full.startswith(os.path.realpath(UI_DIR) + os.sep) or not os.path.isfile(full):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif full.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif full.endswith(".svg"):
            ctype = "image/svg+xml"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def _api_get(self, path):
        gw = self.gateway
        if path == "/api/bridge":
            return self._json(200, gw.bridge())
        if path == "/api/history":
            return self._json(200, {"ok": True, "items": gw.history.recent()})
        if path == "/api/backups":
            return self._json(200, {"ok": True, "items": gw.backups.list(), "saveFile": find_save_file(), "dir": BACKUP_DIR})
        if path == "/api/log":
            try:
                with open(paths.app_path("daemon.log"), "r", encoding="utf-8", errors="replace") as f:
                    lines = f.read().splitlines()[-120:]
            except OSError:
                lines = []
            return self._json(200, {"ok": True, "lines": lines})
        return self._json(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "未知接口"}})

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "令牌无效，请重新打开修改器窗口"}})
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            return self._json(413, {"ok": False, "error": {"code": "TOO_LARGE", "message": "请求过大"}})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"ok": False, "error": {"code": "BAD_REQUEST", "message": "请求不是有效的 JSON"}})
        gw = self.gateway
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/rpc":
            return self._json(200, gw.call(str(body.get("method", "")), body.get("args", [])))
        if path == "/api/undo":
            return self._json(200, gw.undo(int(body.get("id", 0))))
        if path == "/api/backup":
            try:
                return self._json(200, {"ok": True, **gw.backups.make("manual")})
            except Exception as e:  # noqa: BLE001
                return self._json(200, {"ok": False, "error": {"code": "BACKUP_FAILED", "message": str(e)}})
        if path == "/api/open-backups":
            os.makedirs(BACKUP_DIR, exist_ok=True)
            os.startfile(BACKUP_DIR)  # noqa: S606 (local folder chosen by us)
            return self._json(200, {"ok": True})
        if path == "/api/stop-service":
            # Ends the background process. The service itself refuses (GAME_RUNNING) while a game is attached.
            return self._json(200, gw.raw("_shutdown", [], timeout=10))
        if path == "/api/quit":
            self._json(200, {"ok": True})
            if self.on_shutdown:
                threading.Thread(target=self.on_shutdown, daemon=True).start()
            return None
        return self._json(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "未知接口"}})


class ExclusiveServer(ThreadingHTTPServer):
    """On Windows SO_REUSEADDR lets two servers share one port; bind exclusively instead."""

    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def create_server(preferred_port=8765, token=None, on_shutdown=None):
    token = token or secrets.token_urlsafe(24)
    gateway = Gateway()
    for port in range(preferred_port, preferred_port + 40):
        handler = type("BoundHandler", (Handler,), {"token": token, "port": port, "gateway": gateway, "on_shutdown": staticmethod(on_shutdown) if on_shutdown else None})
        try:
            server = ExclusiveServer(("127.0.0.1", port), handler)
        except OSError:
            continue
        server.daemon_threads = True
        server.token = token
        server.port = port
        server.gateway = gateway
        return server
    raise OSError("找不到可用的本地端口（8765–8804 都被占用）")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    server = create_server()
    url = f"http://127.0.0.1:{server.port}/?t={server.token}"
    print("Jump Space 修改器界面:", url, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

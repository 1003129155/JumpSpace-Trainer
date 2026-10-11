"""Read-only GUI smoke check against a running daemon and game."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tkinter as tk
from tool import ItemTool


root = tk.Tk()
root.withdraw()
app = ItemTool(root)


def settle():
    deadline = time.monotonic() + 20
    while app.busy and time.monotonic() < deadline:
        root.update()
        time.sleep(0.02)
    assert not app.busy, "UI request did not finish"
    root.update()


try:
    settle()
    assert app.players, app.status.get()
    assert app.items, app.status.get()
    assert app.player_id is None, "must explicitly select a player"
    app.player_box.current(next(i for i, p in enumerate(app.players) if p["local"]))
    app.select_player()
    settle()
    assert "背包" in app.inventory_text.get()
    app.search.set("MedStim")
    root.update()
    assert len(app.item_by_row) == 1
    row = next(iter(app.item_by_row))
    app.table.selection_set(row)
    root.update()
    assert app.arguments()[0] == "Pickupable_MedStim"
    app.destination.set("ground")
    app.update_policy_state()
    assert str(app.policy_box["state"]) == "disabled"
    app.preview()
    settle()
    assert "计划" in app.status.get(), app.status.get()
    app.search.set("")
    app.category.set("货舱物品 / 舰船部件")
    root.update()
    assert app.item_by_row
    assert all(item["category"] == "cargo" for item in app.item_by_row.values())
    app.read_blueprints()
    settle()
    assert "蓝图" in app.status.get(), app.status.get()
    assert any(isinstance(widget, tk.Toplevel) for widget in root.winfo_children())
    def buttons(widget):
        found = []
        for child in widget.winfo_children():
            if isinstance(child, __import__("tkinter.ttk", fromlist=["Button"]).Button):
                found.append(child["text"])
            found.extend(buttons(child))
        return found
    labels = buttons(root)
    assert "保存选中历史为蓝图" in labels
    assert "解锁选中配方 / 舰船" in labels
    print(f"UI smoke passed: {len(app.players)} players, {len(app.items)} items; selection, search, inventory and preview verified")
finally:
    root.destroy()

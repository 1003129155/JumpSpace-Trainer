"""Tests for the trainer's web gateway: history/undo bookkeeping, RPC allowlist and HTTP hardening.

No game, no daemon: Gateway.raw is replaced with a fake. Run with:  python -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import webui  # noqa: E402


class TempData(unittest.TestCase):
    """Point the module's history file at a throw-away directory."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._saved = (webui.DATA_DIR, webui.HISTORY_FILE, webui.BACKUP_DIR)
        webui.DATA_DIR = self._tmp.name
        webui.HISTORY_FILE = os.path.join(self._tmp.name, "history.jsonl")
        webui.BACKUP_DIR = os.path.join(self._tmp.name, "backups")

    def tearDown(self):
        webui.DATA_DIR, webui.HISTORY_FILE, webui.BACKUP_DIR = self._saved
        self._tmp.cleanup()


CREDITS = {"guid": "g-credits", "display": "信用点"}


def currency_result(before, after, **extra):
    return {"ok": True, "currency": CREDITS, "before": before, "after": after, "changed": before != after, **extra}


class GatewayRecord(TempData):
    def setUp(self):
        super().setUp()
        self.gw = webui.Gateway()
        self.calls = []

        def fake_raw(method, args, timeout=130):
            self.calls.append((method, args))
            return self.reply.get(method, {"ok": True, "changed": True})

        self.reply = {}
        self.gw.raw = fake_raw
        self.gw.backups.ensure_recent = lambda reason: None

    def test_currency_change_records_a_relative_undo(self):
        self.reply["addCurrency"] = currency_result(1000, 6000)
        r = self.gw.call("addCurrency", ["g-credits", "5000"])
        self.assertTrue(r["undoable"])
        entry = self.gw.history.get(r["historyId"])
        self.assertEqual(entry["title"], "信用点")
        self.assertEqual(entry["summary"], "1,000 → 6,000")
        # undo adds the *difference*, so changes made afterwards are not overwritten
        self.assertEqual(entry["undo"], {"method": "addCurrency", "args": ["g-credits", -5000]})

    def test_unchanged_currency_is_not_logged(self):
        self.reply["setCurrency"] = currency_result(500, 500)
        r = self.gw.call("setCurrency", ["g-credits", "500"])
        self.assertNotIn("historyId", r)
        self.assertEqual(self.gw.history.recent(), [])

    def test_clamped_currency_is_flagged_in_the_summary(self):
        self.reply["setCurrency"] = currency_result(10, 99999, clamped=True)
        r = self.gw.call("setCurrency", ["g-credits", "9999999"])
        self.assertIn("已达上限", self.gw.history.get(r["historyId"])["summary"])

    def test_materia_undo_is_relative(self):
        self.reply["addMateria"] = {"ok": True, "changed": True, "before": {"amount": 20}, "after": {"amount": 250}}
        r = self.gw.call("addMateria", ["230"])
        self.assertEqual(self.gw.history.get(r["historyId"])["undo"], {"method": "addMateria", "args": [-230]})

    def test_recipe_unlock_undo_relocks_only_what_changed(self):
        self.gw.names["k1"] = "扳手"
        self.reply["unlockRecipes"] = {
            "ok": True,
            "failed": 0,
            "results": [
                {"ok": True, "key": "k1", "changed": True},
                {"ok": True, "key": "k2", "changed": False},  # was already unlocked: must stay unlocked on undo
            ],
        }
        r = self.gw.call("unlockRecipes", [["k1", "k2"]])
        entry = self.gw.history.get(r["historyId"])
        self.assertEqual(entry["summary"], "扳手")
        self.assertEqual(entry["undo"], {"method": "lockRecipes", "args": [["k1"]]})

    def test_adding_to_the_discovery_history_is_logged_and_undoable(self):
        self.gw.names["r1"] = "物质散射反应堆"
        self.reply["makeBlueprint"] = {"ok": True, "blueprint": {"status": "found", "instanceGuid": "found-9", "level": 1, "rarity": "Common"}}
        r = self.gw.call("makeBlueprint", ["r1", "history", {"tier": 0}])
        entry = self.gw.history.get(r["historyId"])
        self.assertEqual((entry["title"], entry["summary"]), ("加入发现历史", "物质散射反应堆（普通品质 · 1 级）"))
        self.assertEqual(entry["undo"], {"method": "removeRecipeBlueprints", "args": [[{"guid": "found-9", "where": "history"}]]})

    def test_saving_into_a_slot_is_logged_with_the_slot_undo(self):
        self.gw.names["r1"] = "零波反应堆"
        self.reply["makeBlueprint"] = {"ok": True, "blueprint": {"status": "saved", "instanceGuid": "bp-7", "level": 12, "rarity": "Legendary", "slot": 2}}
        r = self.gw.call("makeBlueprint", ["r1", "slot", {"tier": 3, "level": "max"}])
        entry = self.gw.history.get(r["historyId"])
        self.assertEqual((entry["title"], entry["summary"]), ("存入蓝图槽", "零波反应堆（传说品质 · 12 级）"))
        self.assertEqual(entry["undo"], {"method": "removeRecipeBlueprints", "args": [[{"guid": "bp-7", "where": "slot", "level": 12, "rarity": "Legendary"}]]})

    def test_a_blueprint_the_game_refused_is_logged_without_undo(self):
        self.reply["makeBlueprint"] = {"ok": False, "error": {"code": "BLUEPRINT_NOSLOT", "message": "「反应堆」的蓝图槽已满"}}
        r = self.gw.call("makeBlueprint", ["r1", "slot", {"tier": 0}])
        entry = self.gw.history.get(r["historyId"])
        self.assertEqual((entry["ok"], entry["title"], entry["summary"]), (False, "制作蓝图", "「反应堆」的蓝图槽已满"))
        self.assertFalse(r["undoable"])

    def test_the_module_editor_is_a_read_that_never_needs_a_save_backup(self):
        seen = []
        self.gw.backups.ensure_recent = lambda reason: seen.append(reason)
        self.reply["gearEdit"] = {"ok": True, "evaluation": {"errors": []}}
        r = self.gw.call("gearEdit", ["r1", {"tier": 2}, "preview"])
        self.assertTrue(r["ok"])
        self.assertNotIn("historyId", r)
        self.assertEqual(seen, [])
        self.reply["makeBlueprint"] = {"ok": True, "blueprint": {"status": "found", "instanceGuid": "found-1", "level": 1, "rarity": "Common"}}
        self.assertEqual(self.gw.call("makeBlueprint", ["r1", "history", {"tier": 0}]).get("ok"), True)
        self.assertEqual(seen, ["auto"])  # making an item does back up the save first

    def test_blueprint_changes_and_removals_back_up_the_save_file_first(self):
        seen = []
        self.gw.backups.ensure_recent = lambda reason: seen.append(reason) or {"name": "20260101-000000_auto"}
        self.gw.call("makeBlueprint", ["r1", "history", {"tier": 0}])
        self.gw.call("removeRecipeBlueprints", [[{"guid": "bp-1", "where": "slot"}]])
        self.assertEqual(seen, ["auto", "auto"])

    def test_relocking_reports_what_it_removed(self):
        self.gw.names["r1"] = "物质散射反应堆"
        self.reply["lockRecipes"] = {
            "ok": True,
            "results": [{"ok": True, "key": "r1", "changed": True}],
            "blueprints": [{"guid": "bp-1", "removed": True}, {"guid": "bp-2", "removed": False, "reason": "changed"}],
        }
        r = self.gw.call("lockRecipes", [["r1"], [{"guid": "bp-1", "where": "slot"}, {"guid": "bp-2", "where": "slot"}]])
        self.assertIn("并移除 1 个蓝图", self.gw.history.get(r["historyId"])["summary"])

    def test_cheat_toggles_are_logged_with_their_multiplier(self):
        self.reply["setCheat"] = {"ok": True, "cheats": [{"name": "speed", "label": "移动速度", "enabled": True, "param": {"label": "倍率", "unit": "×", "value": 2.0}}]}
        r = self.gw.call("setCheat", ["speed", True, 2])
        entry = self.gw.history.get(r["historyId"])
        self.assertEqual((entry["title"], entry["summary"]), ("移动速度", "已开启　倍率 ×2"))
        self.reply["setCheat"] = {"ok": True, "cheats": [{"name": "speed", "label": "移动速度", "enabled": False, "param": {"label": "倍率", "unit": "×", "value": 2.0}}]}
        r = self.gw.call("setCheat", ["speed", False])
        self.assertEqual(self.gw.history.get(r["historyId"])["summary"], "已关闭")

    def test_tuning_a_running_cheat_is_allowed_but_not_logged(self):
        self.reply["setCheatParam"] = {"ok": True, "cheats": []}
        r = self.gw.call("setCheatParam", ["speed", "3"])
        self.assertTrue(r["ok"])
        self.assertNotIn("historyId", r)
        self.assertEqual(self.gw.history.recent(), [])

    def test_ship_unlock_has_no_undo(self):
        self.reply["unlockShips"] = {"ok": True, "failed": 0, "results": [{"ok": True, "key": "s1", "changed": True}]}
        r = self.gw.call("unlockShips", [["s1"]])
        self.assertFalse(r["undoable"])

    def test_failures_are_recorded_with_the_error_message(self):
        self.reply["spawn"] = {"ok": False, "error": {"code": "BACKPACK_FULL", "message": "背包已满"}}
        r = self.gw.call("spawn", ["Pickupable_Mop", "1", "backpack"])
        entry = self.gw.history.get(r["historyId"])
        self.assertFalse(entry["ok"])
        self.assertEqual(entry["summary"], "背包已满")

    def test_unknown_and_malformed_calls_never_reach_the_game(self):
        self.assertEqual(self.gw.call("eval", ["1+1"])["error"]["code"], "FORBIDDEN")
        self.assertEqual(self.gw.call("addCurrency", "not-a-list")["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.gw.call("addCurrency", list(range(9)))["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.calls, [])

    def test_only_profile_writes_trigger_a_save_backup(self):
        seen = []
        self.gw.backups.ensure_recent = lambda reason: seen.append(reason) or {"name": "20260101-000000_auto"}
        self.gw.call("setCheat", ["god", True])
        self.gw.call("itemList", [])
        self.assertEqual(seen, [])
        self.reply["addCurrency"] = currency_result(1, 2)
        r = self.gw.call("addCurrency", ["g-credits", "1"])
        self.assertEqual(seen, ["auto"])
        self.assertEqual(r["backup"], "20260101-000000_auto")

    def test_failed_backup_never_blocks_the_edit(self):
        self.gw.backups.ensure_recent = lambda reason: {"error": "disk full"}
        self.reply["addCurrency"] = currency_result(1, 2)
        r = self.gw.call("addCurrency", ["g-credits", "1"])
        self.assertTrue(r["ok"])
        self.assertNotIn("backup", r)

    def test_names_are_learned_from_list_responses(self):
        self.gw.learn_names("recipes", {"ok": True, "recipes": [{"key": "a", "display": "扳手"}]})
        self.gw.learn_names("ships", {"ok": True, "ships": [{"key": "b", "display": "飞镖"}]})
        self.gw.learn_names("itemList", {"ok": True, "items": [{"name": "c", "display": "拖把"}]})
        self.gw.learn_names("recipes", {"ok": False})
        self.assertEqual(self.gw.names, {"a": "扳手", "b": "飞镖", "c": "拖把"})


class GatewayUndo(TempData):
    def setUp(self):
        super().setUp()
        self.gw = webui.Gateway()
        self.sent = []
        self.gw.raw = lambda method, args, timeout=130: (self.sent.append((method, args)) or {"ok": True})
        self.gw.backups.ensure_recent = lambda reason: None

    def entry_with_undo(self):
        return self.gw.history.add({"method": "addCurrency", "ok": True, "title": "信用点", "summary": "", "undo": {"method": "addCurrency", "args": ["g", -5]}})

    def test_undo_runs_once_and_logs_itself(self):
        e = self.entry_with_undo()
        self.assertTrue(self.gw.undo(e["id"])["ok"])
        self.assertEqual(self.sent, [("addCurrency", ["g", -5])])
        self.assertTrue(self.gw.history.get(e["id"])["undone"])
        self.assertEqual(self.gw.history.recent()[0]["title"], "撤销：信用点")
        self.assertEqual(self.gw.undo(e["id"])["error"]["code"], "NOT_UNDOABLE")  # not twice
        self.assertEqual(len(self.sent), 1)

    def test_entries_without_undo_or_unknown_ids_are_rejected(self):
        plain = self.gw.history.add({"method": "spawn", "ok": True, "title": "x", "summary": "", "undo": None})
        self.assertEqual(self.gw.undo(plain["id"])["error"]["code"], "NOT_UNDOABLE")
        self.assertEqual(self.gw.undo(999)["error"]["code"], "NOT_UNDOABLE")

    def test_failed_undo_stays_available(self):
        e = self.entry_with_undo()
        self.gw.raw = lambda method, args, timeout=130: {"ok": False, "error": {"code": "NOT_CONNECTED", "message": "x"}}
        self.assertFalse(self.gw.undo(e["id"])["ok"])
        self.assertFalse(self.gw.history.get(e["id"]).get("undone", False))


class HistoryPersistence(TempData):
    def test_entries_and_undone_flags_survive_a_restart(self):
        h = webui.History()
        a = h.add({"title": "a", "undo": {"method": "m", "args": []}})
        b = h.add({"title": "b"})
        h.mark_undone(a["id"])
        again = webui.History()
        self.assertEqual([x["title"] for x in again.recent()], ["b", "a"])
        self.assertTrue(again.get(a["id"]).get("undone"))
        self.assertFalse(again.get(b["id"]).get("undone", False))
        self.assertEqual(again.add({"title": "c"})["id"], b["id"] + 1)  # ids keep counting

    def test_corrupt_lines_are_skipped_and_only_the_latest_300_kept(self):
        with open(webui.HISTORY_FILE, "w", encoding="utf-8") as f:
            f.write("not json\n")
            for i in range(1, 321):
                f.write(json.dumps({"id": i, "time": 0, "title": str(i)}) + "\n")
        h = webui.History()
        self.assertEqual(len(h.items), 300)
        self.assertEqual(h.recent(1)[0]["id"], 320)
        self.assertEqual(h.next_id, 321)


class HttpHardening(TempData):
    @classmethod
    def setUpClass(cls):
        # the gateway reads/creates its history when built: keep that away from the real data folder
        cls._tmp = tempfile.TemporaryDirectory()
        cls._saved = (webui.DATA_DIR, webui.HISTORY_FILE, webui.BACKUP_DIR)
        webui.DATA_DIR = cls._tmp.name
        webui.HISTORY_FILE = os.path.join(cls._tmp.name, "history.jsonl")
        webui.BACKUP_DIR = os.path.join(cls._tmp.name, "backups")
        cls.server = webui.create_server(preferred_port=18765, token="test-token")
        cls.server.gateway.raw = lambda method, args, timeout=130: {"ok": True, "echo": method}
        cls.server.gateway.backups.ensure_recent = lambda reason: None
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        webui.DATA_DIR, webui.HISTORY_FILE, webui.BACKUP_DIR = cls._saved
        cls._tmp.cleanup()

    def request(self, path, method="GET", body=None, headers=None):
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(), headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def test_page_needs_the_token_and_gets_it_injected(self):
        self.assertEqual(self.request("/")[0], 401)
        self.assertEqual(self.request("/?t=wrong")[0], 401)
        status, body, headers = self.request("/?t=test-token")
        self.assertEqual(status, 200)
        self.assertIn(b"test-token", body)
        self.assertNotIn(b"__JB_TOKEN__", body)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])

    def test_api_requires_the_header_token(self):
        self.assertEqual(self.request("/api/history")[0], 401)
        self.assertEqual(self.request("/api/history", headers={"X-JB-Token": "nope"})[0], 401)
        self.assertEqual(self.request("/api/history", headers={"X-JB-Token": "test-token"})[0], 200)
        self.assertEqual(self.request("/api/rpc", "POST", {"method": "itemList", "args": []})[0], 401)

    def test_rpc_roundtrip_and_allowlist(self):
        h = {"X-JB-Token": "test-token", "Content-Type": "application/json"}
        status, body, _ = self.request("/api/rpc", "POST", {"method": "itemList", "args": []}, h)
        self.assertEqual((status, json.loads(body)["echo"]), (200, "itemList"))
        _, body, _ = self.request("/api/rpc", "POST", {"method": "__proto__", "args": []}, h)
        self.assertEqual(json.loads(body)["error"]["code"], "FORBIDDEN")

    def test_foreign_host_headers_are_refused(self):
        # DNS-rebinding defence: even with a valid token a foreign Host never gets anything
        h = {"X-JB-Token": "test-token", "Host": "evil.example"}
        self.assertEqual(self.request("/api/history", headers=h)[0], 403)
        self.assertEqual(self.request("/?t=test-token", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("/style.css", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("/api/rpc", "POST", {"method": "itemList", "args": []}, h)[0], 401)

    def test_static_files_cannot_escape_the_ui_folder(self):
        self.assertEqual(self.request("/style.css")[0], 200)
        self.assertEqual(self.request("/..%2Fwebui.py")[0], 404)
        self.assertEqual(self.request("/..%2f..%2fwebui.py")[0], 404)
        self.assertEqual(self.request("/js/../../webui.py")[0], 404)
        self.assertEqual(self.request("/nope.html")[0], 404)

    def test_invalid_json_and_oversized_bodies_are_rejected(self):
        h = {"X-JB-Token": "test-token"}
        req = urllib.request.Request(self.base + "/api/rpc", method="POST", data=b"{nope", headers=h)
        try:
            urllib.request.urlopen(req, timeout=5)
            self.fail("expected an HTTP error")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def test_stop_service_forwards_the_request_and_reports_a_refusal(self):
        h = {"X-JB-Token": "test-token", "Content-Type": "application/json"}
        seen = []
        original = self.server.gateway.raw
        self.server.gateway.raw = lambda method, args, timeout=130: seen.append(method) or {"ok": False, "error": {"code": "GAME_RUNNING", "message": "游戏正在运行"}}
        try:
            status, body, _ = self.request("/api/stop-service", "POST", {}, h)
        finally:
            self.server.gateway.raw = original
        self.assertEqual(seen, ["_shutdown"])
        self.assertEqual(json.loads(body)["error"]["code"], "GAME_RUNNING")
        self.assertEqual(self.request("/api/stop-service", "POST", {})[0], 401)  # needs the token like everything else

    def test_second_server_gets_a_different_port(self):
        other = webui.create_server(preferred_port=self.server.port, token="x")
        try:
            self.assertNotEqual(other.port, self.server.port)
        finally:
            other.server_close()


if __name__ == "__main__":
    unittest.main()

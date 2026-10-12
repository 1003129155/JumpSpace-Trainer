// The mission itself: the jump map (the nodes of a mission and the links the ship may follow) and ending the mission.
//
// The player jumps from the map by charging the jump drive and the game calls Spaceship_JumpController.JumpTo with the
// chosen node's destination; the server then runs the jump without looking at which nodes are linked, the link rule is
// only in what the map lets a player pick. `jumpToNode` calls JumpTo for any node. `completeMission` raises the event the
// game raises itself when the final jump has finished, and the mission ends the way it does then.
const MAP = "Keepsake.GameplayFeatures.JumpMap.JumpMap";
const SCENARIO = "Keepsake.HyperSpace.GameplayFeatures.Campaigns.Scenario.Scenario";

export function installMission(JB, ex) {
  const { U, onMain, bridgeError, rpcSafe, safe } = JB;

  const text = (s) => (s && !s.isNull() ? s.content || "" : "");
  const flag = (o, name) => !!safe(() => o.method(name).invoke(), false);
  const first = (cls) => U.all(cls, false)[0] || null;

  function mapNodes() {
    const map = first(MAP);
    if (!map) return null;
    const list = map.field("m_DestinationNodes").value;
    return list.isNull() ? [] : JB.managedRows(list, (n) => n);
  }

  const destinationOf = (node) => safe(() => node.method("get_DestinationLocation").invoke(), null);
  const handleOf = (o) => (o && !o.isNull() ? String(o.handle) : "");

  function position(node) {
    const v = safe(() => node.method("get_JumpMapPosition").invoke().method("get_Value").invoke(), null);
    return v ? [v.field("x").value, v.field("z").value] : [0, 0]; // the map lies in the x-z plane
  }

  // what the map's icon says the node is (敌对封锁, 商人, 隐藏储藏点 ...) and what is known about it; the nodes of a mission
  // map have no names of their own
  function kindOf(node) {
    const icon = safe(() => node.method("get_IconData").invoke(), null);
    if (!icon || icon.isNull()) return { type: "", note: "" };
    const note = safe(() => text(icon.method("get_Description").invoke()), "");
    return { type: safe(() => text(icon.method("get_LocationTypeName").invoke()), ""), note: note.startsWith("JumpMap_") ? "" : note };
  }

  function describe(node, index, indexOfDestination) {
    const links = safe(() => JB.managedRows(node.method("get_GetLinkedDestinationLocations").invoke(), (d) => indexOfDestination.get(handleOf(d))), []);
    const kind = kindOf(node);
    return {
      index,
      name: safe(() => text(node.method("get_DisplayName").invoke()), "") || kind.type,
      type: kind.type,
      sub: safe(() => text(node.method("get_SubText").invoke()), "") || kind.note,
      level: safe(() => node.method("get_LevelIndex").invoke(), 0),
      pos: position(node),
      links: links.filter((i) => Number.isInteger(i)),
      current: flag(node, "get_IsCurrent"),
      reachable: flag(node, "get_IsReachable"),
      visited: flag(node, "get_Visited"),
      finale: flag(node, "get_IsFinale"),
      exit: flag(node, "get_IsExit"),
      lava: flag(node, "get_IsConsumedByLavaWall"),
      heat: safe(() => Math.round(node.method("get_Heat").invoke() * 100) / 100, 0),
    };
  }

  const jumpController = () => first("Keepsake.Spaceship_JumpController");

  Object.assign(ex, {
    // the jump map of the mission in progress (available: false outside a mission)
    jumpMap: rpcSafe(() => onMain(() => {
      const nodes = mapNodes();
      if (!nodes) return { available: false };
      const indexOf = new Map(nodes.map((n, i) => [handleOf(destinationOf(n)), i]));
      const rows = nodes.map((n, i) => describe(n, i, indexOf));
      const ctl = jumpController();
      return { available: true, nodes: rows, traveling: !!ctl && flag(ctl, "get_IsTravelingToDestination") };
    })),

    // jump the ship to any node of the map, linked or not
    jumpToNode: rpcSafe((index) => onMain(() => {
      const nodes = mapNodes();
      if (!nodes) throw bridgeError("NO_MISSION", "现在不在任务里，没有跳跃图");
      const node = nodes[Number(index)];
      if (!node) throw bridgeError("NODE_NOT_FOUND", "没有这个节点，请刷新跳跃图");
      if (flag(node, "get_IsCurrent")) throw bridgeError("ALREADY_THERE", "飞船已经在这个节点了");
      const ctl = jumpController();
      if (!ctl) throw bridgeError("NO_SHIP", "没有找到飞船的跳跃系统");
      if (flag(ctl, "get_IsTravelingToDestination")) throw bridgeError("JUMP_IN_PROGRESS", "飞船正在跳跃中，等跳完再选");
      const destination = destinationOf(node);
      if (!destination || destination.isNull()) throw bridgeError("NO_DESTINATION", "这个节点没有目的地");
      ctl.method("JumpTo").invoke(destination);
      const indexOf = new Map(nodes.map((n, i) => [handleOf(destinationOf(n)), i]));
      return { node: describe(node, Number(index), indexOf) };
    })),

    // end the mission now, as if it had been completed
    completeMission: rpcSafe(() => onMain(() => {
      JB.requireServer();
      const scenario = first(SCENARIO);
      if (!scenario) throw bridgeError("NO_MISSION", "现在不在任务里");
      scenario.method("CompleteThisScenario").invoke();
      return { completed: true };
    })),
  });
}

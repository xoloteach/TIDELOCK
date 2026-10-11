extends SceneTree

var failures := 0
var checks := 0

func expect(condition: bool, label: String) -> void:
	checks += 1
	if not condition:
		failures += 1
		printerr("FAIL: " + label)

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var game := Campaign.new()
	game.save_path = "user://test-campaign-temporary.json"
	expect(not HarborData.blocked(HarborData.START), "spawn is walkable")
	for i in range(3):
		expect(not HarborData.blocked(HarborData.FUSES[i]), "fuse %d reachable" % i)
		expect(not HarborData.blocked(HarborData.PUMPS[i] + Vector2(0, 70)), "pump %d reachable" % i)
		expect(not HarborData.blocked(HarborData.LOGS[i]), "log %d reachable" % i)
	expect(HarborData.blocked(Vector2(500, 400)), "warehouse is solid")
	expect(HarborData.blocked(Vector2(1800, 700)), "canal cannot be crossed off bridge")
	expect(not HarborData.blocked(Vector2(1620, 700)), "bridge is walkable")
	# Cross the full bridge from land at both ends; a centre-point test misses sealed approaches.
	for bridge in HarborData.BRIDGES:
		var crossing := Campaign.new()
		crossing.assist = true
		crossing.position = Vector2(bridge.get_center().x, HarborData.CANAL.end.y + 45)
		for frame in range(80):
			crossing.update(1.0 / 60, Vector2.UP, false)
		expect(crossing.position.y < HarborData.CANAL.position.y - 20, "bridge crosses from south bank")
		crossing.position = Vector2(bridge.get_center().x, HarborData.CANAL.position.y - 45)
		for frame in range(80):
			crossing.update(1.0 / 60, Vector2.DOWN, false)
		expect(crossing.position.y > HarborData.CANAL.end.y + 20, "bridge crosses from north bank")
	expect(HarborData.blocked(Vector2(2030, 1170)), "gate closed initially")
	expect(not HarborData.blocked(Vector2(2030, 1170), 15, true), "gate opens after repairs")
	expect(not game.repair(0, HarborData.TARGETS[0]), "repair rejects missing fuse")
	game.position = HarborData.FUSES[0]
	expect(game.nearest().kind == "fuse", "context selects fuse")
	game.collect_fuse(0)
	game.collect_fuse(0)
	expect(game.fuse_count == 1, "fuse pickup cannot duplicate")
	expect(not game.repair(0, [0, 0, 0]), "wrong bypass rejected")
	expect(game.fuse_count == 1, "wrong bypass does not consume fuse")
	expect(game.repair(0, HarborData.TARGETS[0]), "correct bypass restores pump")
	expect(game.fuse_count == 0, "repair consumes exactly one fuse")
	expect(not game.repair(0, HarborData.TARGETS[0]), "pump cannot repair twice")
	game.finish()
	expect(not game.won, "ending requires all pumps")
	for i in [1, 2]:
		game.collect_fuse(i)
		expect(game.repair(i, HarborData.TARGETS[i]), "pump %d complete" % i)
	game.position = HarborData.EXIT
	game.logs = [true, true, false]
	game.health = 73
	game.time_left = 243
	game.finish()
	expect(game.won, "three repaired pumps permit ending")
	var loaded := Campaign.new()
	loaded.save_path = game.save_path
	expect(loaded.load_game(), "checkpoint roundtrip loads")
	expect(loaded.pumps == game.pumps and loaded.logs == game.logs, "mission and logs restored")
	expect(loaded.position == game.position and loaded.health == 73, "position and suit restored")
	expect(loaded.won and loaded.fuse_count == 0, "ending and inventory restored")
	var invalid := {"version": 1}
	expect(not Campaign.valid_save(invalid), "truncated checkpoint rejected")
	var file := FileAccess.open(game.save_path, FileAccess.WRITE)
	file.store_string("broken json")
	file.close()
	expect(not loaded.load_game(), "corrupt checkpoint rejected")
	var patrol := Campaign.new()
	patrol.save_path = game.save_path
	patrol.position = patrol.drones[0].position + Vector2(40, 0)
	var before := patrol.health
	for i in range(100):
		patrol.update(1.0 / 60, Vector2.ZERO, false)
	expect(patrol.health < before, "real patrol detection damages suit")
	patrol.pulse()
	expect(patrol.drones[0].stun > 0, "pulse stuns nearby patrol")
	expect(not patrol.pulse(), "pulse cooldown enforced")
	var alert := patrol.health
	for i in range(60):
		patrol.update(1.0 / 60, Vector2.ZERO, false)
	expect(patrol.health == alert, "stunned patrol cannot damage")
	patrol.assist = true
	var tide := patrol.time_left
	patrol.update(2.0, Vector2.ZERO, false)
	expect(patrol.time_left == tide, "explorer mode freezes tide")
	patrol.assist = false
	patrol.health = 0
	patrol.rescue("test")
	expect(patrol.health == 100 and patrol.position == HarborData.START, "rescue returns to a safe checkpoint")
	patrol.time_left = 0.01
	patrol.update(1.0, Vector2.ZERO, false)
	expect(patrol.time_left >= 180 and patrol.rescues == 2, "tide failure recovers without losing mission")
	var mover := Campaign.new()
	var start := mover.position
	mover.update(1.0 / 60, Vector2.RIGHT, true)
	expect(mover.position.x > start.x and mover.stamina < 100, "sprint moves and spends stamina")
	mover.position = Vector2(250, 400)
	mover.update(1.0, Vector2.RIGHT, false)
	expect(mover.position.x == 250, "movement cannot enter warehouse")
	expect(not HarborData.clear_sight(Vector2(250, 400), Vector2(840, 400)), "warehouse occludes machine sight")
	# People, props and story state.
	for i in range(HarborData.NPC_IDS.size()):
		expect(HarborData.blocked(HarborData.NPC_POSITIONS[i]), "%s is solid" % HarborData.NPC_IDS[i])
		expect(Story.SCENES.has(HarborData.NPC_IDS[i]) and Story.REPEAT.has(HarborData.NPC_IDS[i]), "%s has a scene and a repeat line" % HarborData.NPC_IDS[i])
		for entry in Story.SCENES[HarborData.NPC_IDS[i]]:
			expect(Story.SPEAKERS.has(entry[0]) and not str(entry[1]).is_empty(), "scene line has a known speaker")
			if entry.size() > 2:
				for option in entry[2]:
					expect(option.size() == 4 and Story.SPEAKERS.has(option[1]) and not str(option[3]).is_empty(), "choice has a reply and a flag")
	var all_points := [HarborData.START, HarborData.EXIT]
	for i in range(3):
		all_points.append_array([HarborData.FUSES[i], HarborData.LOGS[i], HarborData.PUMPS[i] + Vector2(0, 70)])
	for point in all_points:
		var clear := true
		for box in HarborData.SOLID_CACHE:
			if box.grow(34).has_point(point):
				clear = false
		expect(clear, "props and people keep clear of objective %s" % point)
	var talker := Campaign.new()
	talker.save_path = game.save_path
	talker.position = HarborData.NPC_POSITIONS[0] + Vector2(-60, 0)
	expect(not HarborData.blocked(talker.position), "Ivo can be approached")
	expect(talker.nearest().kind == "npc" and talker.nearest().index == 0, "context selects Ivo")
	talker.position = Vector2(2000, 1290)
	expect(talker.nearest().kind != "npc", "Sera cannot be reached through the closed gate")
	talker.pumps = [true, true, true]
	talker.position = Vector2(2060, 1250)
	expect(talker.nearest().kind == "npc" and talker.nearest().index == 2, "Sera waits beyond the open gate")
	talker.pumps = [false, false, false]
	talker.position = HarborData.FUSES[0]
	expect(talker.nearest().kind == "fuse", "fuse still wins at its crate")
	talker.talk(0, "ivo_trust")
	talker.talk(0, "ivo_trust")
	expect(talker.talked[0] and talker.flags.count("ivo_trust") == 1, "conversation and choice recorded once")
	var listener := Campaign.new()
	listener.save_path = game.save_path
	expect(listener.load_game() and listener.talked[0] and "ivo_trust" in listener.flags, "story state survives checkpoint")
	var legacy: Dictionary = JSON.parse_string(JSON.stringify({"version": 1, "position": [430, 1190], "checkpoint": [430, 1190], "health": 100, "time": 480, "pumps": [false, false, false], "collected": [false, false, false], "logs": [false, false, false], "fuses": 0, "rescues": 0, "won": false, "assist": false}))
	expect(Campaign.valid_save(legacy), "saves from before the story update still load")
	legacy["flags"] = [3]
	expect(not Campaign.valid_save(legacy), "malformed story flags rejected")
	# World-building content.
	for key in ["bridge", "weir_yard", "canal", "log_1", "log_2", "log_3", "tide_2min", "rescue"]:
		expect(Lore.RADIO_EVENTS.has(key), "radio event %s has lines" % key)
		for entry in Lore.RADIO_EVENTS.get(key, []):
			expect(Story.SPEAKERS.has(entry[0]), "radio speaker %s is known" % entry[0])
	for id in Lore.BARKS:
		for entry in Lore.BARKS[id]:
			expect(Story.SPEAKERS.has(entry[0]), "bark speaker %s is known" % entry[0])
	for note in Lore.NOTES:
		var spot: Vector2 = note[2]
		for point in all_points:
			expect(spot.distance_to(point) > 100.0, "notice %s keeps clear of objectives" % note[0])
		var reachable := false
		for angle in range(0, 360, 15):
			var stand: Vector2 = spot + Vector2.from_angle(deg_to_rad(angle)) * 60.0
			if not HarborData.blocked(stand, 15, true):
				reachable = true
		expect(reachable, "notice %s can be reached on foot" % note[0])
	var reader := Campaign.new()
	reader.save_path = game.save_path
	reader.read_note(0)
	reader.read_log(0)
	expect("r_log_1" in reader.flags, "reading a log fires its radio event once")
	var rereader := Campaign.new()
	rereader.save_path = game.save_path
	expect(rereader.load_game() and rereader.notes_read[0], "read notices survive checkpoint")
	DirAccess.remove_absolute(game.save_path)
	world_edge_checks()
	print("Campaign checks: %d passed / %d total" % [checks - failures, checks])
	quit(1 if failures > 0 else 0)

# ---- World-building placement checks (world plan section 5, items 1-7).

# The browser planner in scripts/godot/smoke.cjs: 19 u padding, 30 u grid, 8 u steps.
func clear_line(a: Vector2, b: Vector2, open: bool) -> bool:
	var n := maxi(1, ceili(a.distance_to(b) / 8.0))
	for i in range(n + 1):
		if HarborData.blocked(a.lerp(b, float(i) / n), 19.0, open):
			return false
	return true

func grid_route(start: Vector2, target: Vector2, open: bool) -> bool:
	var grid := 30.0
	var root := Vector2i(roundi(start.x / grid), roundi(start.y / grid))
	if HarborData.blocked(Vector2(root) * grid, 19.0, open):
		var best := INF
		var found := root
		for dx in range(-3, 4):
			for dy in range(-3, 4):
				var c := root + Vector2i(dx, dy)
				if not HarborData.blocked(Vector2(c) * grid, 19.0, open) and Vector2(dx, dy).length() < best:
					best = Vector2(dx, dy).length()
					found = c
		root = found
	var queue: Array[Vector2i] = [root]
	var seen := {root: true}
	var cursor := 0
	while cursor < queue.size():
		var cell := queue[cursor]
		cursor += 1
		var point := Vector2(cell) * grid
		if point.distance_to(target) < 42.0 and clear_line(point, target, open):
			return true
		for d in [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1), Vector2i(1, 1), Vector2i(1, -1), Vector2i(-1, 1), Vector2i(-1, -1)]:
			var n: Vector2i = cell + d
			if seen.has(n):
				continue
			if clear_line(point, Vector2(n) * grid, open):
				seen[n] = true
				queue.append(n)
	return false

func rect_point_distance(r: Rect2, p: Vector2) -> float:
	var dx := maxf(maxf(r.position.x - p.x, 0.0), p.x - r.end.x)
	var dy := maxf(maxf(r.position.y - p.y, 0.0), p.y - r.end.y)
	return Vector2(dx, dy).length()

func rect_gap(a: Rect2, b: Rect2) -> float:
	var dx := maxf(maxf(b.position.x - a.end.x, a.position.x - b.end.x), 0.0)
	var dy := maxf(maxf(b.position.y - a.end.y, a.position.y - b.end.y), 0.0)
	return Vector2(dx, dy).length()

func axis_middle(a0: float, a1: float, b0: float, b1: float) -> float:
	if a1 < b0:
		return (a1 + b0) / 2.0
	if b1 < a0:
		return (b1 + a0) / 2.0
	return (maxf(a0, b0) + minf(a1, b1)) / 2.0

func gap_middle(a: Rect2, b: Rect2) -> Vector2:
	return Vector2(axis_middle(a.position.x, a.end.x, b.position.x, b.end.x), axis_middle(a.position.y, a.end.y, b.position.y, b.end.y))

func rect_segment_distance(r: Rect2, a: Vector2, b: Vector2) -> float:
	var best := INF
	var n := maxi(1, ceili(a.distance_to(b) / 2.0))
	for i in range(n + 1):
		best = minf(best, rect_point_distance(r, a.lerp(b, float(i) / n)))
	return best

func patrol_distance(r: Rect2) -> float:
	var best := INF
	for route in HarborData.PATROLS:
		for i in route.size():
			best = minf(best, rect_segment_distance(r, route[i], route[(i + 1) % route.size()]))
	return best

func world_edge_checks() -> void:
	# 1. Grid routes, exactly as the browser playthrough plans them.
	var targets: Array[Vector2] = [Vector2(535, 1112), Vector2(1635, 585), Vector2(1635, 815)]
	for i in range(3):
		targets.append_array([HarborData.FUSES[i], HarborData.LOGS[i], HarborData.PUMPS[i] + Vector2(0, 70)])
	for target in targets:
		expect(grid_route(HarborData.START, target, false), "planner route from START to %s" % target)
	expect(grid_route(HarborData.START, HarborData.EXIT, true), "planner route from START to EXIT with the gate open")
	expect(not grid_route(HarborData.START, HarborData.EXIT, false), "planner cannot pass the closed gate")
	expect(not grid_route(HarborData.START, Vector2(545, 405), false), "planner cannot route into a warehouse")
	expect(grid_route(Vector2(1635, 585), Vector2(1635, 815), false), "planner crosses bridge 1 southbound")
	expect(grid_route(Vector2(2005, 815), Vector2(2005, 585), false), "planner crosses bridge 2 northbound")
	# 2. Bridge approaches stay clear of every solid.
	for bridge: Rect2 in HarborData.BRIDGES:
		for approach in [Rect2(bridge.position.x, bridge.position.y - 120, bridge.size.x, 120), Rect2(bridge.position.x, bridge.end.y, bridge.size.x, 120)]:
			for box in HarborData.SOLID_CACHE:
				expect(not box.grow(20).intersects(approach), "bridge approach %s clear of %s" % [approach, box])
	# 3. Cross each bridge from well north of the canal.
	for bridge: Rect2 in HarborData.BRIDGES:
		var walker := Campaign.new()
		walker.assist = true
		walker.position = Vector2(bridge.get_center().x, HarborData.CANAL.position.y - 100)
		for frame in range(120):
			walker.update(1.0 / 60, Vector2.DOWN, false)
		expect(walker.position.y > HarborData.CANAL.end.y + 20, "bridge crosses from 100 u north of the canal")
	# New solids: the set pieces, procedural dressing and the concrete barriers.
	var fresh: Array[Rect2] = []
	var tall: Array[Rect2] = []
	for piece in HarborData.SET_PIECES:
		var r := Rect2(piece[1] - piece[4] / 2, piece[4])
		fresh.append(r)
		if piece[3].y > 1.2:
			tall.append(r)
	for box in HarborData.DRESSING_SOLIDS:
		fresh.append(box)
		if box.has_point(HarborEdge.JIB_CRANE):
			tall.append(box)
	for prop in HarborData.PROPS:
		if prop[0] == "concrete_road_barrier":
			fresh.append(Rect2(prop[1] - prop[4] / 2, prop[4]))
	expect(tall.size() == 3, "ambulance, van and crane pedestal are the tall set pieces")
	var objectives: Array[Vector2] = [HarborData.START, HarborData.EXIT]
	for i in range(3):
		objectives.append_array([HarborData.FUSES[i], HarborData.LOGS[i], HarborData.PUMPS[i] + Vector2(0, 70)])
	var canal_gate := Rect2(2020, 1090, 28, 270)
	for r in fresh:
		expect(r in HarborData.SOLID_CACHE, "%s is in the solid cache" % r)
		# 4. Patrol clearance: drones never drive through dressing; tall pieces sit well away.
		var patrol := patrol_distance(r)
		expect(patrol >= 40.0, "%s keeps 40 u from patrol lanes (%.0f)" % [r, patrol])
		if r in tall:
			expect(patrol >= 300.0, "tall %s keeps 300 u from patrol lanes (%.0f)" % [r, patrol])
		# 5. No pinch points: every gap is sealed (<= 30 u) or a corridor (>= 90 u).
		var others: Array[Rect2] = [HarborData.CANAL, canal_gate]
		for box in HarborData.BUILDINGS + HarborData.SOLID_CACHE:
			if box != r:
				others.append(box)
		for other in others:
			var gap := rect_gap(r, other)
			if gap > 30.0 and gap < 90.0:
				# A third obstacle standing in the middle of the gap seals it.
				var middle := gap_middle(r, other)
				for third in others:
					if third != other and third.grow(1).has_point(middle):
						gap = 0.0
			expect(gap <= 30.0 or gap >= 90.0, "gap %s to %s is %.0f u" % [r, other, gap])
		var bounds := HarborData.BOUNDS
		for gap in [r.position.x - bounds.position.x, bounds.end.x - r.end.x, r.position.y - bounds.position.y, bounds.end.y - r.end.y]:
			expect(gap <= 30.0 or gap >= 90.0, "gap %s to the quay edge is %.0f u" % [r, gap])
		# 6. Clearance to objectives and readable notices.
		for point in objectives:
			expect(rect_point_distance(r, point) >= 34.0, "%s keeps 34 u from objective %s" % [r, point])
		for note in Lore.NOTES:
			expect(rect_point_distance(r, note[2]) >= 60.0, "%s keeps 60 u from notice %s" % [r, note[0]])
	# 7. Non-solid dressing stays where Mara can never stand.
	var walk := HarborData.BOUNDS.grow(-15)
	for p: Vector2 in HarborEdge.BOLLARDS:
		var reach := HarborEdge.BOLLARD_RADIUS * 50.0
		for corner in [p + Vector2(reach, reach), p - Vector2(reach, reach), p + Vector2(reach, -reach), p + Vector2(-reach, reach)]:
			expect(not walk.has_point(corner), "bollard %s stays in the coping band" % p)
	for p: Vector2 in HarborEdge.LADDERS:
		expect(not HarborData.BOUNDS.grow(-12).has_point(p), "ladder %s is on the quay edge" % p)
	for p: Vector2 in HarborEdge.GATE_PIERS:
		expect(not walk.has_point(p), "tide-lock pier %s is outside the walkable quay" % p)
	for row: float in HarborEdge.RAIL_ROWS:
		for run: Vector2 in HarborEdge.RAIL_RUNS:
			for x in HarborEdge.rail_posts(run):
				var post := Vector2(x, row)
				expect(HarborData.CANAL.grow(15).has_point(post), "railing post %s is in the canal band" % post)
				for bridge: Rect2 in HarborData.BRIDGES:
					expect(x <= bridge.position.x - 10 or x >= bridge.end.x + 10, "railing post %s is clear of the bridge span" % post)

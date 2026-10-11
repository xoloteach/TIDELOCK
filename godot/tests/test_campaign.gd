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
	print("Campaign checks: %d passed / %d total" % [checks - failures, checks])
	quit(1 if failures > 0 else 0)

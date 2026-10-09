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
	DirAccess.remove_absolute(game.save_path)
	print("Campaign checks: %d passed / %d total" % [checks - failures, checks])
	quit(1 if failures > 0 else 0)

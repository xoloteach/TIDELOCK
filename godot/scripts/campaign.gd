class_name Campaign
extends RefCounted

signal message(text: String)
signal repaired(index: int)
signal damaged
signal completed
signal radio(key: String)

const SAVE_PATH := "user://tidelock-harbor-v1.json"
var position := HarborData.START
var heading := Vector2.UP
var look_yaw := 0.0
var look_pitch := 0.0
var health := 100.0
var stamina := 100.0
var time_left := 480.0
var pumps := [false, false, false]
var collected := [false, false, false]
var logs := [false, false, false]
var fuse_count := 0
var drones: Array[Dictionary] = []
var invulnerable := 0.0
var pulse_cooldown := 0.0
var pulse_ring := 0.0
var checkpoint := HarborData.START
var won := false
var record_choice := ""
var rescues := 0
var alarm := 0.0
var assist := false
var save_error := ""
var save_path := SAVE_PATH
var talked := [false, false, false]
var flags: Array[String] = []

func _init() -> void:
	reset_drones()

func reset_drones() -> void:
	drones.clear()
	for path in HarborData.PATROLS:
		drones.append({"position": path[0], "path": path, "target": 1, "heading": Vector2.RIGHT, "stun": 0.0, "alert": 0.0})

func update(delta: float, movement: Vector2, sprint: bool) -> void:
	if won:
		return
	invulnerable = maxf(0.0, invulnerable - delta)
	pulse_cooldown = maxf(0.0, pulse_cooldown - delta)
	pulse_ring = maxf(0.0, pulse_ring - delta * 1.7)
	var speed := 175.0
	if sprint and stamina > 2.0 and movement.length() > 0.1:
		speed = 275.0
		stamina = maxf(0.0, stamina - delta * 27.0)
	else:
		stamina = minf(100.0, stamina + delta * 20.0)
	if movement.length() > 0.05:
		heading = movement.normalized()
	var step := movement.limit_length() * speed * delta
	var next := position + Vector2(step.x, 0)
	if not HarborData.blocked(next, 15, pumps.count(true) == 3):
		position = next
	next = position + Vector2(0, step.y)
	if not HarborData.blocked(next, 15, pumps.count(true) == 3):
		position = next
	if not assist:
		time_left -= delta * (1.0 - pumps.count(true) * 0.18)
	if time_left <= 0:
		rescue("The surge crossed the seawall. Sera pulled you back. Try another route.")
		return
	var seen := false
	for drone in drones:
		drone.stun = maxf(0.0, drone.stun - delta)
		if drone.stun > 0:
			drone.alert = 0.0
			continue
		var destination: Vector2 = drone.path[drone.target]
		var direction: Vector2 = destination - drone.position
		if direction.length() < 8:
			drone.target = (drone.target + 1) % drone.path.size()
		else:
			drone.heading = direction.normalized()
			drone.position += drone.heading * delta * 65.0
		var offset: Vector2 = position - drone.position
		var detected: bool = offset.length() < 65.0 or (offset.length() < 245.0 and drone.heading.dot(offset.normalized()) > 0.73)
		detected = detected and HarborData.clear_sight(drone.position, position)
		drone.alert = move_toward(drone.alert, 1.0 if detected else 0.0, delta * (1.3 if detected else 1.8))
		seen = seen or detected
		if detected and not "spotted" in flags:
			flags.append("spotted")
			radio.emit("spotted")
		if drone.alert >= 1.0 and invulnerable <= 0 and not assist:
			health -= 25.0
			invulnerable = 2.4
			damaged.emit()
			message.emit("Emergency access denied. Break line of sight or use your pulse tool [Q].")
			if health <= 0:
				rescue("Mara's radio went quiet. Sera found you at the last restored pump.")
				return
	alarm = move_toward(alarm, 1.0 if seen else 0.0, delta * 2)

func pulse() -> bool:
	if pulse_cooldown > 0:
		message.emit("Pulse tool recharging: %ds." % ceili(pulse_cooldown))
		return false
	pulse_cooldown = 9.0
	pulse_ring = 1.0
	for drone in drones:
		if position.distance_to(drone.position) < 270.0:
			drone.stun = 5.0
	message.emit("Induction pulse / nearby machines paused for 5 seconds.")
	return true

func nearest() -> Dictionary:
	var best := {"kind": "", "index": -1, "distance": 85.0}
	for i in range(3):
		if not collected[i]:
			consider(best, "fuse", i, HarborData.FUSES[i])
		if not pumps[i]:
			consider(best, "pump", i, HarborData.PUMPS[i])
		if not logs[i]:
			consider(best, "log", i, HarborData.LOGS[i])
	if pumps.count(true) == 3:
		consider(best, "exit", 0, HarborData.EXIT)
	for i in range(HarborData.NPC_IDS.size()):
		# Sera waits beyond the east gate; she is only reachable once it opens.
		if HarborData.NPC_IDS[i] == "sera" and pumps.count(true) < 3:
			continue
		# People only win the prompt when they are clearly the closest thing.
		var distance := position.distance_to(HarborData.NPC_POSITIONS[i])
		if distance < 100.0 and (best.kind.is_empty() or distance < best.distance - 10.0):
			best.kind = "npc"
			best.index = i
			best.distance = distance
	return best

func consider(best: Dictionary, kind: String, index: int, point: Vector2) -> void:
	var distance := position.distance_to(point)
	if distance < best.distance:
		best.kind = kind
		best.index = index
		best.distance = distance

func collect_fuse(index: int) -> void:
	if collected[index]:
		return
	collected[index] = true
	fuse_count += 1
	message.emit("Ceramic fuse recovered. Install one at a pump panel [E].")
	save_game()

func repair(index: int, dials: Array) -> bool:
	if pumps[index] or fuse_count <= 0 or dials != HarborData.TARGETS[index]:
		return false
	pumps[index] = true
	fuse_count -= 1
	checkpoint = HarborData.PUMPS[index] + Vector2(0, 85)
	health = minf(100.0, health + 20)
	time_left = minf(480.0, time_left + 45.0)
	repaired.emit(index)
	save_game()
	if pumps.count(true) == 3:
		message.emit("SERA / All three pumps drawing. East gate released. Get to the evacuation beacon.")
		radio.emit("gate")
	else:
		if pumps.count(true) == 1:
			radio.emit("first_pump")
		message.emit("SERA / P-0%d is drawing. Checkpoint saved. The tide is slowing." % (index + 1))
	return true

func talk(index: int, choice_flag: String = "") -> void:
	talked[index] = true
	if not choice_flag.is_empty() and not choice_flag in flags:
		flags.append(choice_flag)
	save_game()

func rescue(text: String) -> void:
	position = checkpoint
	health = 100.0
	time_left = maxf(time_left, 180.0)
	stamina = 100.0
	invulnerable = 5.0
	rescues += 1
	reset_drones()
	message.emit(text)
	save_game()

func finish() -> void:
	if pumps.count(true) != 3:
		return
	won = true
	save_game()
	completed.emit()

static func has_checkpoint() -> bool:
	if OS.has_feature("web"):
		var exists = JavaScriptBridge.eval("try { localStorage.getItem('tidelock-harbor-v1') !== null; } catch (e) { false; }", true)
		if bool(exists):
			return true
	return FileAccess.file_exists(SAVE_PATH)

func save_game() -> bool:
	var payload := JSON.stringify({"version": 1, "yaw": look_yaw, "pitch": look_pitch, "position": [position.x, position.y], "checkpoint": [checkpoint.x, checkpoint.y], "health": health, "time": time_left, "pumps": pumps, "collected": collected, "logs": logs, "fuses": fuse_count, "rescues": rescues, "won": won, "assist": assist, "record": record_choice, "talked": talked, "flags": flags})
	var browser_saved := true
	if OS.has_feature("web"):
		browser_saved = bool(JavaScriptBridge.eval("try { localStorage.setItem('tidelock-harbor-v1', " + JSON.stringify(payload) + "); true; } catch (e) { console.warn('TIDELOCK checkpoint storage unavailable: ' + e.message); false; }", true))
	var file := FileAccess.open(save_path, FileAccess.WRITE)
	if file == null:
		save_error = "Checkpoint could not be written: %s" % error_string(FileAccess.get_open_error())
		message.emit(save_error)
		return false
	file.store_string(payload)
	file.close()
	if OS.has_feature("web"):
		JavaScriptBridge.force_fs_sync()
	if not browser_saved:
		message.emit("Browser storage unavailable. Progress is in memory; checkpoints may not survive reload.")
	return browser_saved

func load_game() -> bool:
	var raw: Variant = null
	if OS.has_feature("web"):
		raw = JavaScriptBridge.eval("try { localStorage.getItem('tidelock-harbor-v1'); } catch (e) { null; }", true)
	if not raw is String:
		if not FileAccess.file_exists(save_path):
			return false
		var file := FileAccess.open(save_path, FileAccess.READ)
		if file == null:
			message.emit("Checkpoint could not be read.")
			return false
		raw = file.get_as_text()
	var parser := JSON.new()
	if parser.parse(raw) != OK:
		message.emit("Checkpoint JSON is invalid. Start a new recovery mission.")
		return false
	var data = parser.data
	if not valid_save(data):
		message.emit("Checkpoint is invalid. Start a new recovery mission.")
		return false
	pumps = data.pumps.duplicate()
	collected = data.collected.duplicate()
	logs = data.logs.duplicate()
	position = Vector2(float(data.position[0]), float(data.position[1]))
	checkpoint = Vector2(float(data.checkpoint[0]), float(data.checkpoint[1]))
	look_yaw = float(data.get("yaw", 0.0))
	look_pitch = clampf(float(data.get("pitch", 0.0)), -1.25, 1.25)
	health = clampf(float(data.health), 1, 100)
	time_left = clampf(float(data.time), 60, 480)
	fuse_count = int(data.fuses)
	rescues = int(data.rescues)
	won = bool(data.won)
	record_choice = str(data.get("record", ""))
	assist = bool(data.assist)
	talked = data.get("talked", [false, false, false]).duplicate()
	flags.clear()
	for flag in data.get("flags", []):
		flags.append(str(flag))
	if HarborData.blocked(position, 15, pumps.count(true) == 3):
		position = checkpoint
	if HarborData.blocked(position, 15, pumps.count(true) == 3):
		position = HarborData.START
	invulnerable = 3.0
	return true

static func valid_save(data: Variant) -> bool:
	if not data is Dictionary or data.get("version") != 1:
		return false
	for key in ["pumps", "collected", "logs"]:
		if not data.get(key) is Array or data[key].size() != 3:
			return false
		for value in data[key]:
			if not value is bool:
				return false
	for key in ["position", "checkpoint"]:
		if not data.get(key) is Array or data[key].size() != 2:
			return false
		for value in data[key]:
			if not (value is float or value is int) or not is_finite(float(value)):
				return false
	for key in ["yaw", "pitch"]:
		if data.has(key) and (not (data[key] is float or data[key] is int) or not is_finite(float(data[key]))):
			return false
	for key in ["health", "time", "fuses", "rescues"]:
		if not (data.get(key) is float or data.get(key) is int):
			return false
		if not is_finite(float(data[key])):
			return false
	if not data.get("won") is bool or not data.get("assist") is bool:
		return false
	if data.get("record", "") not in ["", "broadcast", "archive"]:
		return false
	# Story fields arrived after the first release; older saves omit them.
	if data.has("talked"):
		if not data.talked is Array or data.talked.size() != 3:
			return false
		for value in data.talked:
			if not value is bool:
				return false
	if data.has("flags"):
		if not data.flags is Array or data.flags.size() > 32:
			return false
		for value in data.flags:
			if not value is String or value.length() > 32:
				return false
	var balance: int = data.collected.count(true) - data.pumps.count(true)
	return int(data.fuses) == balance and balance >= 0 and balance <= 3 and (not data.won or data.pumps.count(true) == 3)

extends Node2D

const SETTINGS_PATH := "user://tidelock-settings-v1.json"
var campaign: Campaign
var view: FirstPersonView
var ui: HarborInterface
var audio: Soundscape
var started := false
var settings_return := "title"
var joystick_id := -1
var touch_device := false
var look_touch_id := -1
var look_touch_position := Vector2.ZERO
var bridge_timer := 0.0
# Conversation state: the active scene, its line, and a pending choice reply.
var talk_npc := -1
var talk_lines: Array = []
var talk_index := 0
var talk_reply := false
var talk_flag := ""

func _ready() -> void:
	configure_input()
	campaign = Campaign.new()
	view = FirstPersonView.new()
	view.campaign = campaign
	add_child(view)
	var canvas := CanvasLayer.new()
	add_child(canvas)
	ui = HarborInterface.new()
	ui.campaign = campaign
	ui.has_save = Campaign.has_checkpoint()
	ui.touch = DisplayServer.is_touchscreen_available()
	if OS.has_feature("web"):
		ui.touch = ui.touch or bool(JavaScriptBridge.eval("matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch')"))
	touch_device = ui.touch
	canvas.add_child(ui)
	ui.mode_changed.connect(reset_touch)
	get_viewport().size_changed.connect(reset_touch)
	ui.command.connect(action)
	audio = Soundscape.new()
	add_child(audio)
	view.footstep.connect(func(): audio.step(on_bridge()))
	ui.radio_started.connect(func(): audio.cue("radio"))
	view.thunder.connect(func(strength: float): audio.thunder(strength))
	connect_campaign()
	load_settings()
	ui.show_mode("title")
	publish_state()

func configure_input() -> void:
	var mapping := {
		"move_up": [KEY_W, KEY_UP], "move_down": [KEY_S, KEY_DOWN],
		"move_left": [KEY_A, KEY_LEFT], "move_right": [KEY_D, KEY_RIGHT],
		"flashlight": [KEY_F], "jump": [KEY_SPACE], "sprint": [KEY_SHIFT], "interact": [KEY_E], "pulse": [KEY_Q],
		"pause_game": [KEY_ESCAPE], "journal": [KEY_TAB],
		"valve_one": [KEY_1], "valve_two": [KEY_2], "valve_three": [KEY_3]
	}
	for name in mapping:
		if not InputMap.has_action(name):
			InputMap.add_action(name)
		for key in mapping[name]:
			var event := InputEventKey.new()
			event.physical_keycode = key
			InputMap.action_add_event(name, event)

func connect_campaign() -> void:
	campaign.message.connect(ui.inform)
	campaign.repaired.connect(func(index: int):
		audio.cue("repair")
		view.burst(HarborData.PUMPS[index],true)
	)
	campaign.damaged.connect(func():
		view.damage_flash = 0.7
		audio.cue("damage")
	)
	campaign.radio.connect(func(key: String):
		ui.radio({"spotted": Story.RADIO_SPOTTED, "first_pump": Story.RADIO_FIRST_PUMP, "gate": Story.RADIO_GATE}.get(key, []))
		if key == "gate":
			audio.cue("gate")
	)
	campaign.damaged.connect(func(): view.alarm_cue())
	campaign.completed.connect(func():
		ui.ending = ""
		ui.show_mode("ending")
		audio.cue("repair")
	)

func _physics_process(delta: float) -> void:
	if ui != null and ui.mode == "playing":
		var movement := Input.get_vector("move_left", "move_right", "move_up", "move_down")
		if ui.joystick.length() > 0.05:
			movement = ui.joystick
		view.moving = movement.length() > 0.05
		var right := Vector2(cos(view.yaw), -sin(view.yaw))
		var forward := Vector2(-sin(view.yaw), -cos(view.yaw))
		movement = right * movement.x + forward * -movement.y
		campaign.look_yaw = view.yaw
		campaign.look_pitch = view.pitch
		campaign.update(delta, movement, Input.is_action_pressed("sprint") or ui.sprint_held)

func _process(delta: float) -> void:
	if ui == null:
		return
	view.moving = view.moving and ui.mode == "playing"
	var wanted := Input.MOUSE_MODE_CAPTURED if ui.mode == "playing" and not ui.touch else Input.MOUSE_MODE_VISIBLE
	if Input.mouse_mode != wanted:
		Input.mouse_mode = wanted
	view.menu = not started or ui.mode == "title"
	view.reduced_motion = ui.reduced_motion
	view.sound_enabled = ui.sound_enabled
	ui.hit_flash = view.damage_flash
	bridge_timer += delta
	if bridge_timer > 0.15:
		bridge_timer = 0
		publish_state()

func _input(event: InputEvent) -> void:
	if ui != null and event is InputEventScreenTouch and event.pressed and not ui.touch:
		touch_device = true
		ui.touch = true
		ui.show_mode(ui.mode)
	if ui != null and (event.is_action_pressed("journal") or event.is_action_pressed("pause_game")):
		_unhandled_input(event)
		get_viewport().set_input_as_handled()
		return
	if ui != null and ui.mode == "playing" and not ui.touch and event is InputEventMouseMotion:
		view.look(event.relative)
		get_viewport().set_input_as_handled()
		return
	if ui == null or ui.mode != "playing" or not ui.touch:
		return
	if event is InputEventScreenTouch:
		if not event.pressed:
			if event.index == joystick_id:
				joystick_id = -1
				ui.joystick = Vector2.ZERO
				ui.stick_origin = Vector2(124,586)
				get_viewport().set_input_as_handled()
			if event.index == look_touch_id:
				look_touch_id = -1
			return
		if ui.touch_button_at(event.position):
			return
		if event.position.x < 460 and event.position.y > 300 and event.position.y < 720 and joystick_id < 0:
			joystick_id = event.index
			if event.position.distance_to(ui.stick_origin) > 115:
				ui.stick_origin = event.position.clamp(Vector2(85,380),Vector2(420,620))
			update_stick(event.position)
			get_viewport().set_input_as_handled()
		elif event.position.x >= 460 and event.position.y > 150 and look_touch_id < 0:
			look_touch_id = event.index
			look_touch_position = event.position
			get_viewport().set_input_as_handled()
	elif event is InputEventScreenDrag:
		if event.index == look_touch_id:
			view.look((event.position - look_touch_position).limit_length(120) * 1.8)
			look_touch_position = event.position
			get_viewport().set_input_as_handled()
		elif event.index == joystick_id:
			update_stick(event.position)
			get_viewport().set_input_as_handled()

func update_stick(point: Vector2) -> void:
	var offset := (point - ui.stick_origin) / 62.0
	ui.joystick = Vector2.ZERO if offset.length() < 0.10 else offset.limit_length()

func reset_touch() -> void:
	joystick_id = -1
	look_touch_id = -1
	if ui != null:
		ui.joystick = Vector2.ZERO
		ui.stick_origin = Vector2(124,586)
		ui.sprint_held = false

func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT and is_instance_valid(ui):
		reset_touch()
		if ui.mode == "playing":
			action("pause")

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.echo:
		return
	if ui.mode == "dialogue":
		if event.is_action_pressed("pause_game"):
			end_conversation()
		elif event.is_action_pressed("interact") or event.is_action_pressed("jump") or event.is_action_pressed("ui_accept"):
			action("advance")
		else:
			for i in range(3):
				if event.is_action_pressed(["valve_one", "valve_two", "valve_three"][i]):
					action("choose_%d" % i)
		return
	if event.is_action_pressed("flashlight") and ui.mode == "playing":
		view.flashlight_enabled = not view.flashlight_enabled
	elif event.is_action_pressed("jump") and ui.mode == "playing":
		view.jump()
	elif event.is_action_pressed("pause_game"):
		if ui.mode == "playing":
			action("pause")
		elif ui.mode == "title":
			pass
		elif ui.mode in ["settings", "help", "credits"]:
			action("back")
		elif ui.mode != "ending":
			action("resume")
	elif event.is_action_pressed("journal"):
		if ui.mode == "playing":
			action("journal")
		elif ui.mode == "journal":
			action("resume")
	elif event.is_action_pressed("interact"):
		if ui.mode == "playing":
			action("interact")
		elif ui.mode == "puzzle":
			action("confirm")
	elif event.is_action_pressed("pulse") and ui.mode == "playing":
		action("pulse")
	elif ui.mode == "puzzle":
		for i in range(3):
			if event.is_action_pressed(["valve_one", "valve_two", "valve_three"][i]):
				action("rotate_%d" % i)

func action(command: String) -> void:
	if command.begins_with("rotate_") and ui.mode == "puzzle":
		var index := int(command.trim_prefix("rotate_"))
		ui.dials[index] = (ui.dials[index] + 1) % 4
		ui.puzzle_error = ""
		audio.cue("valve")
		return
	if command.begins_with("choose_") and ui.mode == "dialogue":
		choose(int(command.trim_prefix("choose_")))
		publish_state()
		return
	match command:
		"new":
			if ui.has_save:
				ui.show_mode("confirm_new")
			else:
				start_new()
		"new_confirmed":
			start_new()
		"continue":
			if campaign.load_game():
				started = true
				view.yaw = campaign.look_yaw
				view.pitch = campaign.look_pitch
				view.camera = campaign.position
				ui.ending = campaign.record_choice
				ui.show_mode("ending" if campaign.won else "playing")
			else:
				ui.title_error = "Checkpoint could not be loaded. Begin a new recovery mission to replace it."
				ui.has_save = false
				ui.show_mode("title")
		"title":
			if started:
				campaign.save_game()
			ui.has_save = Campaign.has_checkpoint()
			ui.show_mode("title")
		"pause":
			ui.show_mode("pause")
		"resume":
			joystick_id = -1
			look_touch_id = -1
			ui.show_mode("playing" if started else "title")
		"save":
			var saved := campaign.save_game()
			ui.show_mode("playing")
			if saved:
				ui.inform("Checkpoint saved / progress will be here when you return.")
		"rescue":
			campaign.rescue("Returned to the last restored pump. Recovered fuses and logs retained.")
			ui.show_mode("playing")
		"journal":
			ui.show_mode("journal")
		"settings", "help", "credits":
			settings_return = ui.mode
			ui.show_mode(command)
		"back":
			ui.show_mode(settings_return)
		"sound":
			ui.sound_enabled = not ui.sound_enabled
			audio.set_enabled(ui.sound_enabled)
			save_settings()
			ui.show_mode("settings")
		"motion":
			ui.reduced_motion = not ui.reduced_motion
			save_settings()
			ui.show_mode("settings")
		"touch":
			ui.touch = not ui.touch
			save_settings()
			ui.show_mode("settings")
		"assist":
			campaign.assist = not campaign.assist
			save_settings()
			if started:
				campaign.save_game()
			ui.show_mode("settings")
		"light":
			view.flashlight_enabled = not view.flashlight_enabled
		"pulse":
			if ui.mode == "playing" and campaign.pulse():
				audio.cue("pulse")
				view.burst(campaign.position)
		"interact":
			interact()
		"advance":
			advance_conversation()
		"confirm":
			if ui.mode != "puzzle":
				return
			if campaign.repair(ui.puzzle_index, ui.dials):
				ui.show_mode("playing")
			else:
				ui.puzzle_error = "BYPASS REJECTED / MATCH ALL THREE OUTLETS BEFORE ENERGIZING"
				audio.cue("error")
		"broadcast", "archive":
			ui.ending = command
			campaign.record_choice = command
			campaign.save_game()
			ui.show_mode("ending")
	publish_state()

func start_new() -> void:
	ui.title_error = ""
	view.yaw = 0
	view.pitch = 0
	var explorer := campaign.assist
	campaign = Campaign.new()
	campaign.assist = explorer
	view.campaign = campaign
	view.camera = campaign.position
	ui.campaign = campaign
	connect_campaign()
	started = true
	campaign.save_game()
	ui.show_mode("playing")
	ui.clear_radio()
	ui.radio(Story.RADIO_INTRO)
	ui.inform("SERA / Start with the depot fuse box. Your compass points to supplies, then pumps. [E] to use; [Tab] for the map.")

func interact() -> void:
	if ui.mode != "playing":
		return
	var nearest := campaign.nearest()
	var index: int = nearest.index
	match nearest.kind:
		"fuse":
			campaign.collect_fuse(index)
			audio.cue("click")
		"pump":
			if campaign.fuse_count <= 0:
				ui.inform("One ceramic fuse required. Amber supply boxes are marked on your map [Tab].")
				return
			ui.puzzle_index = index
			ui.dials = [1, 2, 0]
			ui.puzzle_error = ""
			ui.show_mode("puzzle")
		"log":
			campaign.logs[index] = true
			campaign.save_game()
			ui.log_text = HarborData.LOG_TEXT[index]
			ui.show_mode("log")
		"exit":
			campaign.finish()
		"npc":
			start_conversation(index)
		_:
			ui.inform("Move closer to a fuse box, pump panel or shift log. [Tab] opens the recovery map.")

func on_bridge() -> bool:
	for bridge in HarborData.BRIDGES:
		if bridge.has_point(campaign.position):
			return true
	return false

func start_conversation(index: int) -> void:
	var id: String = HarborData.NPC_IDS[index]
	if campaign.talked[index]:
		ui.radio([Story.REPEAT[id]])
		view.speak(index, 3.0)
		return
	talk_npc = index
	talk_lines = Story.SCENES[id]
	talk_index = 0
	talk_reply = false
	talk_flag = ""
	view.focus(index)
	show_line()

func show_line() -> void:
	var entry: Array = talk_lines[talk_index]
	ui.dialogue_line = [entry[0], entry[1]]
	ui.dialogue_options = entry[2] if entry.size() > 2 else []
	view.speak(talk_npc if entry[0] != "mara" else -1, Story.duration(entry[1]))
	ui.show_mode("dialogue")

func advance_conversation() -> void:
	if ui.mode != "dialogue" or (not ui.dialogue_options.is_empty() and not talk_reply):
		return
	talk_reply = false
	talk_index += 1
	audio.cue("click")
	if talk_index >= talk_lines.size():
		end_conversation()
	else:
		show_line()

func choose(option: int) -> void:
	if talk_reply or option >= ui.dialogue_options.size():
		return
	var picked: Array = ui.dialogue_options[option]
	talk_flag = picked[3]
	talk_reply = true
	ui.dialogue_line = [picked[1], picked[2]]
	ui.dialogue_options = []
	view.speak(talk_npc, Story.duration(picked[2]))
	audio.cue("click")
	ui.show_mode("dialogue")

func end_conversation() -> void:
	if talk_npc >= 0:
		campaign.talk(talk_npc, talk_flag)
	talk_npc = -1
	view.focus(-1)
	ui.show_mode("playing")
	publish_state()

func save_settings() -> void:
	var payload := JSON.stringify({"sound": ui.sound_enabled, "motion": ui.reduced_motion, "touch": ui.touch, "assist": campaign.assist})
	if OS.has_feature("web"):
		var saved = JavaScriptBridge.eval("try { localStorage.setItem('tidelock-settings-v1', " + JSON.stringify(payload) + "); true; } catch (e) { false; }", true)
		if not bool(saved):
			ui.inform("Browser settings storage unavailable. Changes apply to this session.")
	var file := FileAccess.open(SETTINGS_PATH, FileAccess.WRITE)
	if file == null:
		ui.inform("Field settings could not be saved: " + error_string(FileAccess.get_open_error()))
		return
	file.store_string(payload)
	file.close()
	if OS.has_feature("web"):
		JavaScriptBridge.force_fs_sync()

func load_settings() -> void:
	var raw: Variant = null
	if OS.has_feature("web"):
		raw = JavaScriptBridge.eval("try { localStorage.getItem('tidelock-settings-v1'); } catch (e) { null; }", true)
	if not raw is String:
		if not FileAccess.file_exists(SETTINGS_PATH):
			return
		var file := FileAccess.open(SETTINGS_PATH, FileAccess.READ)
		if file == null:
			return
		raw = file.get_as_text()
	var parser := JSON.new()
	if parser.parse(raw) != OK:
		ui.inform("Saved field settings were invalid. Using safe defaults.")
		return
	var data = parser.data
	if not data is Dictionary:
		return
	ui.sound_enabled = bool(data.get("sound", true))
	ui.reduced_motion = bool(data.get("motion", false))
	ui.touch = touch_device or bool(data.get("touch", ui.touch))
	campaign.assist = bool(data.get("assist", false))
	audio.set_enabled(ui.sound_enabled)

# Read-only browser diagnostics. Tests still use the same keyboard/touch actions as players.
func publish_state() -> void:
	if not OS.has_feature("web"):
		return
	var data := {"renderer": "first-person-3d", "fps": Engine.get_frames_per_second(), "adapter": RenderingServer.get_video_adapter_name(), "yaw": view.yaw, "pitch": view.pitch, "flashlight": view.flashlight_enabled, "mode": ui.mode, "has_save": ui.has_save, "position": [campaign.position.x, campaign.position.y], "health": campaign.health, "stamina": campaign.stamina, "pumps": campaign.pumps, "fuses": campaign.fuse_count, "collected": campaign.collected, "logs": campaign.logs, "won": campaign.won, "assist": campaign.assist, "touch": ui.touch, "stick": [ui.joystick.x,ui.joystick.y], "move_touch": joystick_id, "look_touch": look_touch_id, "sound": ui.sound_enabled, "motion": ui.reduced_motion, "dials": ui.dials, "puzzle": ui.puzzle_index, "ending": ui.ending, "time": campaign.time_left, "rescues": campaign.rescues, "notice": ui.notice, "talked": campaign.talked, "flags": campaign.flags, "dialogue": ui.dialogue_line if ui.mode == "dialogue" else [], "options": ui.dialogue_options.size() if ui.mode == "dialogue" else 0, "radio": ui.radio_line}
	var world := {"bounds": [140, 160, 2020, 1220], "canal": [1390, 630, 770, 140], "bridges": [], "obstacles": [], "pumps": [], "fuses": [], "logs": [], "exit": [HarborData.EXIT.x, HarborData.EXIT.y]}
	for box in HarborData.BUILDINGS + HarborData.SOLID_CACHE:
		world.obstacles.append([box.position.x, box.position.y, box.size.x, box.size.y])
	world["npcs"] = []
	for point in HarborData.NPC_POSITIONS:
		world.npcs.append([point.x, point.y])
	for box in HarborData.BRIDGES:
		world.bridges.append([box.position.x, box.position.y, box.size.x, box.size.y])
	for point in HarborData.PUMPS:
		world.pumps.append([point.x, point.y])
	for point in HarborData.FUSES:
		world.fuses.append([point.x, point.y])
	for point in HarborData.LOGS:
		world.logs.append([point.x, point.y])
	data["world"] = world
	JavaScriptBridge.eval("window.tidelockState = " + JSON.stringify(data) + "; window.dispatchEvent(new Event('tidelock-state'));", true)

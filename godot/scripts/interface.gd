class_name HarborInterface
extends Control

signal command(action: String)
signal mode_changed
signal radio_started
var campaign: Campaign
var mode := "title"
var buttons: Array[Button] = []
var font: Font = preload("res://fonts/FieldSans.ttf")
var notice := ""
var notice_time := 0.0
var puzzle_index := -1
var dials: Array = [1, 2, 0]
var puzzle_error := ""
var log_text := ""
var log_title := "RECOVERED SHIFT LOG"
var ending := ""
var touch := false
var joystick := Vector2.ZERO
var stick_origin := Vector2(124,586)
var sprint_held := false
var sound_enabled := true
var reduced_motion := false
var has_save := false
var title_error := ""
var clock := 0.0
var hit_flash := 0.0
# Radio subtitles play over gameplay; conversations use the "dialogue" mode.
var radio_queue: Array = []
var radio_line: Array = []
var radio_time := 0.0
var dialogue_line: Array = []
var dialogue_options: Array = []
var fade := 1.0
var target_glow := 0.0
var third_person := false
const INK := Color("102226")
const PAPER := Color("e6e4cc")
const MUTED := Color("94aba5")
const AMBER := Color("e2b46a")
const MINT := Color("8bbab0")
const WARM := Color("ec9871")
# Type scale and spacing for the in-game HUD.
const T_XS := 11
const T_SM := 13
const T_MD := 16
const T_LG := 20
const T_XL := 26
const MARGIN := 36.0
# HUD presentation state: everything fades toward its target instead of snapping.
var obj_key := ""
var obj_text := ""
var obj_age := 99.0
var hud_clock := 0.0
var hints_moved := 0.0
var hints_looked := 0.0
var hints_gone := false
var last_pos := Vector2.ZERO
var last_yaw := 0.0
var idle_time := 0.0
var map_alpha := 0.0
var vitals_alpha := 0.0
var hints_alpha := 0.0
var sub_alpha := 0.0
var sub_age := 0.0
var prompt_text := ""
var prompt_alpha := 0.0
var prompt_key := true
var alarm_alpha := 0.0

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	show_mode("title")

func _process(delta: float) -> void:
	clock += delta
	fade = maxf(0.0, fade - delta * 3.5)
	if mode == "playing":
		notice_time = maxf(0, notice_time - delta)
		radio_time -= delta
		sub_age += delta
		if radio_time <= 0.0:
			radio_line = radio_queue.pop_front() if not radio_queue.is_empty() else []
			radio_time = Story.duration(radio_line[1]) if not radio_line.is_empty() else 0.0
			sub_age = 0.0
			if not radio_line.is_empty() and radio_line.size() < 3:
				radio_started.emit()
		track_hud(delta)
	queue_redraw()

func radio(lines: Array) -> void:
	radio_queue.append_array(lines)

func clear_radio() -> void:
	obj_key = ""
	hud_clock = 0.0
	hints_moved = 0.0
	hints_looked = 0.0
	hints_gone = false
	radio_queue.clear()
	radio_line = []
	radio_time = 0.0

func inform(text: String) -> void:
	notice = text.replace("[E]", "USE").replace("[Tab]", "LOG").replace("[Q]", "PULSE") if touch else text
	notice_time = 9.0
	# Field notes share the subtitle channel. A "SERA / ..." prefix names the speaker.
	var who := ""
	var body := notice
	var split := notice.find(" / ")
	if split > 0 and split < 14:
		var head := notice.substr(0, split)
		for id in Story.SPEAKERS:
			if Story.speaker_name(id).begins_with(head):
				who = id
				body = notice.substr(split + 3)
	# A note cuts in at once; a radio line it interrupts is replayed afterwards.
	if radio_line.size() == 2:
		radio_queue.push_front(radio_line)
	radio_queue.push_front([who, body, "note"])
	radio_time = 0.0

func show_mode(value: String) -> void:
	if value != mode:
		fade = maxf(fade, 0.45)
	mode = value
	for b in buttons:
		remove_child(b)
		b.queue_free()
	buttons.clear()
	sprint_held = false
	joystick = Vector2.ZERO
	mode_changed.emit()
	match mode:
		"title":
			button("BEGIN RECOVERY   →", Rect2(86, 384, 350, 56), "new")
			if has_save:
				button("CONTINUE CHECKPOINT", Rect2(86, 452, 350, 48), "continue")
			button("FIELD SETTINGS", Rect2(86, 518, 170, 44), "settings")
			button("HOW TO PLAY", Rect2(266, 518, 170, 44), "help")
			button("CREDITS", Rect2(446, 518, 120, 44), "credits")
		"playing":
			button("II", Rect2(1188, 23, 52, 42), "pause")
			button("LOG", Rect2(1118, 23, 58, 42), "journal")
			if touch:
				button("LIGHT", Rect2(940,585,95,65), "light")
				button("VIEW", Rect2(940,495,95,60), "view")
				button("USE", Rect2(1053, 545, 108, 70), "interact")
				button("PULSE", Rect2(1173, 480, 86, 64), "pulse")
				var sprint := button("RUN", Rect2(1173, 565, 86, 76), "")
				sprint.button_down.connect(func(): sprint_held = true)
				sprint.button_up.connect(func(): sprint_held = false)
		"pause":
			button("RESUME", Rect2(440, 285, 400, 52), "resume")
			button("SAVE CHECKPOINT", Rect2(440, 349, 400, 48), "save")
			button("FIELD SETTINGS", Rect2(440, 409, 400, 48), "settings")
			button("RETURN TO LAST PUMP", Rect2(440, 469, 400, 48), "rescue")
			button("TITLE SCREEN", Rect2(440, 529, 400, 48), "title")
		"settings":
			button("SOUND   /   " + ("ON" if sound_enabled else "OFF"), Rect2(430, 252, 420, 54), "sound")
			button("STORM MOTION   /   " + ("REDUCED" if reduced_motion else "ON"), Rect2(430, 320, 420, 54), "motion")
			button("TOUCH CONTROLS   /   " + ("ON" if touch else "OFF"), Rect2(430, 388, 420, 54), "touch")
			button("EXPLORER MODE   /   " + ("ON" if campaign.assist else "OFF"), Rect2(430, 456, 420, 54), "assist")
			button("BACK", Rect2(430, 557, 420, 48), "back")
		"credits":
			button("BACK", Rect2(480, 590, 320, 48), "back")
		"help":
			button("GOT IT", Rect2(480, 590, 320, 48), "back")
		"journal", "log":
			button("BACK TO QUAY", Rect2(460, 609, 360, 48), "resume")
		"puzzle":
			for i in range(3):
				button("ROTATE  [%d]" % (i + 1), Rect2(335 + i * 220, 431, 170, 48), "rotate_%d" % i)
			button("ENERGIZE PUMP   [E]", Rect2(425, 563, 430, 52), "confirm")
			button("BACK", Rect2(875, 566, 110, 48), "resume")
		"ending":
			if ending.is_empty():
				button("SEND THE FULL SHIFT RECORD", Rect2(250, 440, 780, 52), "broadcast")
				button("FILE IT WITH THE RECOVERY TEAM", Rect2(250, 505, 780, 52), "archive")
			else:
				button("RETURN TO TITLE", Rect2(460, 593, 360, 52), "title")
		"dialogue":
			if dialogue_options.is_empty():
				button("CONTINUE   " + ("" if touch else "[E]"), Rect2(830, 640, 320, 48), "advance")
			else:
				for i in range(dialogue_options.size()):
					button(("" if touch else "%d   " % (i + 1)) + str(dialogue_options[i][0]), Rect2(250, 470 + i * 62, 780, 52), "choose_%d" % i)
		"confirm_new":
			button("START NEW MISSION", Rect2(430, 379, 420, 52), "new_confirmed")
			button("KEEP CHECKPOINT", Rect2(430, 446, 420, 52), "title")
	if mode != "playing" and not buttons.is_empty() and not touch:
		buttons[0].grab_focus()
	queue_redraw()

func touch_button_at(point: Vector2) -> bool:
	for b in buttons:
		if b.get_rect().grow(10).has_point(point):
			return true
	return false

func button(text: String, box: Rect2, action: String) -> Button:
	var b := Button.new()
	b.text = text
	var layout := box
	if touch:
		layout.size.y = maxf(layout.size.y, 82)
		layout.size.x = maxf(layout.size.x, 86)
		if mode == "title":
			layout.position.y = {384: 376, 452: 470, 518: 564}.get(int(box.position.y), box.position.y)
		elif mode == "playing":
			if action == "journal":
				layout.position.x = 1095
		elif mode == "pause":
			layout.position.y = {285: 230, 349: 322, 409: 414, 469: 506, 529: 598}.get(int(box.position.y), box.position.y)
		elif mode == "settings":
			layout.position.y = {252: 238, 320: 326, 388: 414, 456: 502, 557: 636}.get(int(box.position.y), box.position.y)
		elif mode == "ending" and action == "archive":
			layout.position.y = 535
		elif mode == "confirm_new" and action == "title":
			layout.position.y = 480
		elif mode == "dialogue" and action.begins_with("choose_"):
			layout.position.y = 400 + int(action.trim_prefix("choose_")) * 92
		elif mode == "dialogue":
			layout.position.y = 620
	b.position = layout.position
	b.size = layout.size
	b.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	b.add_theme_font_override("font", font)
	b.add_theme_font_size_override("font_size", 20 if touch else 17)
	if mode == "playing":
		flat_button(b, action)
		add_child(b)
		buttons.append(b)
		return b
	b.add_theme_color_override("font_color", PAPER)
	b.add_theme_color_override("font_hover_color", INK)
	b.add_theme_color_override("font_pressed_color", INK)
	for state in ["normal", "hover", "pressed", "focus"]:
		var style := StyleBoxFlat.new()
		style.bg_color = AMBER if state in ["hover", "pressed"] else Color("233b3e")
		style.border_color = AMBER if state == "focus" else Color("5c716b")
		style.set_border_width_all(2 if state == "focus" else 1)
		style.set_corner_radius_all(2)
		b.add_theme_stylebox_override(state, style)
	if not action.is_empty():
		b.pressed.connect(func(): command.emit(action))
	add_child(b)
	buttons.append(b)
	return b

# In-game buttons: no boxes for LOG / pause, a faint glass chip for touch controls.
func flat_button(b: Button, action: String) -> void:
	var chrome := action in ["pause", "journal"]
	b.add_theme_font_size_override("font_size", T_MD if chrome else T_MD + 2)
	b.add_theme_color_override("font_color", Color(PAPER, 0.62 if chrome else 0.85))
	b.add_theme_color_override("font_hover_color", AMBER)
	b.add_theme_color_override("font_pressed_color", AMBER)
	b.focus_mode = Control.FOCUS_NONE
	for state in ["normal", "hover", "pressed", "focus"]:
		var style := StyleBoxFlat.new()
		style.bg_color = Color(0, 0, 0, 0) if chrome else Color(INK, 0.5 if state == "pressed" else 0.32)
		style.border_color = Color(PAPER, 0.28)
		style.set_border_width_all(0 if chrome else 1)
		style.set_corner_radius_all(3)
		b.add_theme_stylebox_override(state, style)
	if not action.is_empty():
		b.pressed.connect(func(): command.emit(action))

func _draw() -> void:
	paint()
	if fade > 0.0:
		draw_rect(Rect2(0, 0, 1280, 720), Color(0.01, 0.025, 0.03, fade))

func paint() -> void:
	if mode == "playing":
		hud()
		return
	if mode == "dialogue":
		conversation()
		return
	if mode == "title":
		for i in range(12):
			draw_rect(Rect2(i * 60, 0, 60, 720), Color(0.025, 0.07, 0.08, 0.96 - i * 0.046))
		draw_rect(Rect2(0, 0, 1280, 720), Color(0.025, 0.05, 0.065, 0.12))
		line(Vector2(86, 104), Vector2(150, 104), AMBER, 3)
		text(Vector2(166, 110), "BOROUGH FLOOD CONTROL / FIELD EDITION", 14, AMBER)
		text(Vector2(80, 237), "TIDELOCK", 96, PAPER)
		text(Vector2(88, 280), "MORROW QUAY", 28, MUTED)
		paragraph(Vector2(88, 324), "The city left. The water didn't.\nThree pumps. One tide. Bring the quay back by hand.", 490, 18, PAPER)
		text(Vector2(88, 676 if touch else 628), "FIRST-PERSON HARBOR RECOVERY  /  GODOT 4.7.2", 13, MUTED)
		text(Vector2(88, 704 if touch else 657), "HEADPHONES RECOMMENDED     •     KEYBOARD + TOUCH", 12, MUTED)
		compass(Vector2(1040, 170), 72)
		text(Vector2(914, 275), "51° 29′ N   /   00° 04′ E", 14, PAPER)
		panel(Rect2(888, 506, 306, 134), 0.86)
		text(Vector2(911, 537), "NEXT HIGH WATER", 12, AMBER)
		text(Vector2(911, 579), "08:00", 34, PAPER)
		text(Vector2(911, 615), "MANUAL ACCESS REQUIRED", 12, MUTED)
		if not title_error.is_empty():
			panel(Rect2(888, 340, 306, 135), 0.96)
			paragraph(Vector2(910, 372), title_error, 266, 16, AMBER, 24)
		return
	draw_rect(Rect2(0, 0, 1280, 720), Color(0.02, 0.06, 0.07, 0.86))
	match mode:
		"pause":
			heading("HOLD POSITION", "SIMULATION PAUSED / YOUR PROGRESS IS SAFE")
			if not touch:
				text(Vector2(640, 626), "CONTROLS", T_XS, AMBER, true)
				text(Vector2(640, 650), "WASD move    Mouse look    Shift run    E use    Q pulse", T_SM, MUTED, true)
				text(Vector2(640, 672), "F light    V view    Space hop    Tab map    Esc pause", T_SM, MUTED, true)
		"settings":
			heading("FIELD SETTINGS", "CHANGES APPLY IMMEDIATELY AND ARE SAVED LOCALLY")
			text(Vector2(431, 624 if touch else 538), "Explorer mode removes damage and stops the tide clock.", 14, MUTED)
		"credits":
			heading("END OF THE SHIFT SHEET", "TIDELOCK / GODOT HARBOR EDITION")
			paragraph(Vector2(250, 270), "Morrow Quay, its people and story / TIDELOCK project\nPeople / Quaternius Universal Base Characters + Animation Library (CC0), dressed in Blender 5.2\nProps & sky / Poly Haven (CC0)    Structures & SFX / Kenney (CC0)\nRain, pumps, machines, waves, steps / OpenGameArt: Kresiek, rubberduck, Thimras, jasinski (CC0)\nConcrete / ambientCG Concrete030 (CC0)\nEngine / Godot 4.7.2, MIT licence    Typeface / DejaVu Sans\n\nSource code and asset licence notices accompany the web build.", 780, 16, PAPER, 27)
		"help":
			heading("RECOVERY MANUAL", "ONE QUAY / THREE PUMPS / ONE WAY HOME")
			var rows := [
				["01", "Find ceramic fuses in the amber supply boxes."],
				["02", "Carry a fuse to a pump. Match each rotary valve to its marked direction."],
				["03", "Avoid machine search cones. Walls block sight; pulse buys five seconds."],
				["04", "Talk to people on the quay. Restore all three pumps, then reach the east evacuation beacon."]
			]
			for i in range(rows.size()):
				text(Vector2(240, 267 + i * 59), rows[i][0], 23, AMBER)
				text(Vector2(290, 266 + i * 59), rows[i][1], 18, PAPER)
			line(Vector2(240, 482), Vector2(1040, 482), Color("4b6460"))
			paragraph(Vector2(240, 516), "Mouse: look    WASD: move    Shift: run    E: use    Q: pulse\nF: flashlight    V: first / third person    Space: hop    Tab: map    Esc: pause    1 / 2 / 3: valves\nOn touch screens: left stick to move, swipe centre/right to look + USE / RUN / PULSE / VIEW. Landscape recommended.", 800, 17, MUTED)
		"journal":
			heading("THE SHIFT RECORD", "MAP / RECOVERY STATUS / FIELD NOTES")
			minimap(Rect2(160, 225, 420, 315), true)
			for i in range(3):
				text(Vector2(635, 253 + i * 47), ("✓ " if campaign.pumps[i] else "○ ") + HarborData.PUMP_NAMES[i], 20, MINT if campaign.pumps[i] else AMBER)
			text(Vector2(635, 410), "THE MISSING 37 MINUTES", 17, PAPER)
			paragraph(Vector2(635, 440), "Recovered shift logs: %d / 3.\nPaper markers on the map hold accounts from Sera, Dax and Ivo. Read them before filing the recovery report." % campaign.logs.count(true), 490, 17, MUTED)
			var met := []
			for i in range(3):
				if campaign.talked[i]:
					met.append(Story.speaker_name(HarborData.NPC_IDS[i]))
			text(Vector2(635, 548), "SPOKEN WITH  /  " + (", ".join(met) if not met.is_empty() else "NOBODY YET"), 14, PAPER)
			text(Vector2(165, 575), "● MARA    ◇ FUSE    ○ PUMP    ▪ SHIFT LOG    + EVAC", 14, MUTED)
		"log":
			heading(log_title, "PAPER RECORD / MORROW QUAY")
			paragraph(Vector2(260, 287), log_text, 760, 26, PAPER, 40)
		"puzzle":
			puzzle()
		"ending":
			ending_screen()
		"confirm_new":
			heading("A NEW SHIFT?", "THIS REPLACES YOUR EXISTING LOCAL CHECKPOINT")
			paragraph(Vector2(430, 286), "Your current recovery progress will be replaced when the new mission starts.", 420, 20, PAPER)

func heading(title: String, subtitle: String) -> void:
	text(Vector2(640, 144), title, 40, PAPER, true)
	text(Vector2(640, 181), subtitle, 13, AMBER, true)
	line(Vector2(240, 206), Vector2(1040, 206), Color("4b6460"))

func objective_text() -> String:
	if campaign.pumps.count(true) == 3:
		return "Reach the east evacuation beacon"
	if campaign.fuse_count > 0:
		return "Install the fuse at a pump"
	return "Find a ceramic fuse"

# Presentation state for the HUD: what is visible, and how strongly.
func track_hud(delta: float) -> void:
	hud_clock += delta
	obj_age += delta
	var key := objective_text() + str(campaign.pumps.count(true))
	if key != obj_key:
		obj_key = key
		obj_text = objective_text()
		obj_age = 0.0
	var step := campaign.position.distance_to(last_pos)
	last_pos = campaign.position
	if step > 60.0:
		step = 0.0
	var turn := absf(angle_difference(campaign.look_yaw, last_yaw))
	last_yaw = campaign.look_yaw
	if turn > 1.0:
		turn = 0.0
	hints_moved += step
	hints_looked += turn
	if hints_moved > 120.0 and hints_looked > 0.6:
		hints_gone = true
	idle_time = 0.0 if step > 0.3 else idle_time + delta
	var show_map := idle_time > 1.2 or hud_clock < 6.0
	map_alpha = move_toward(map_alpha, 0.85 if show_map else 0.0, delta * (1.6 if show_map else 3.0))
	var sprinting := (Input.is_action_pressed("sprint") or sprint_held) and step > 0.3
	var strained := campaign.health < 99.5 or campaign.stamina < 99.5 or hit_flash > 0.0 or sprinting
	vitals_alpha = move_toward(vitals_alpha, 1.0 if strained else 0.0, delta * (4.0 if strained else 1.2))
	var hints_on := not hints_gone and hud_clock < 20.0
	hints_alpha = move_toward(hints_alpha, 1.0 if hints_on else 0.0, delta * (1.5 if hints_on else 1.2))
	var aim := campaign.nearest()
	var want := prompt_for(aim)
	if not want.is_empty():
		prompt_text = want
		prompt_key = aim.kind != "pump" or campaign.fuse_count > 0
	prompt_alpha = move_toward(prompt_alpha, 1.0 if not want.is_empty() else 0.0, delta * 6.0)
	target_glow = lerpf(target_glow, 0.0 if aim.kind.is_empty() else 1.0, 0.18)
	alarm_alpha = move_toward(alarm_alpha, 1.0 if campaign.alarm > 0.1 else 0.0, delta * 4.0)

func prompt_for(aim: Dictionary) -> String:
	match aim.kind:
		"fuse":
			return "Take fuse"
		"pump":
			var short: String = HarborData.PUMP_NAMES[aim.index].get_slice(" / ", 1)
			return ("Repair " + short) if campaign.fuse_count > 0 else (short + " needs a fuse")
		"log":
			return "Read shift log"
		"note":
			return "Read notice"
		"exit":
			return "Reach the evacuation beacon"
		"npc":
			return "Talk to " + Story.speaker_name(HarborData.NPC_IDS[aim.index]).capitalize()
	return ""

func hud() -> void:
	if hit_flash > 0:
		draw_rect(Rect2(0,0,1280,720),Color(0.9,0.22,0.10,hit_flash*0.16))
		draw_rect(Rect2(4,4,1272,712),Color(0.9,0.3,0.15,hit_flash),false,8)
	# Soft edge shading keeps type readable without boxes.
	shade(0.0, 120.0, 0.34, true)
	# Crosshair opens into a ring when something can be used.
	var gap := 2.0 + target_glow * 5.0
	line(Vector2(632 - gap,360),Vector2(638 - gap,360),PAPER,2)
	line(Vector2(642 + gap,360),Vector2(648 + gap,360),PAPER,2)
	line(Vector2(640,352 - gap),Vector2(640,358 - gap),PAPER,2)
	line(Vector2(640,362 + gap),Vector2(640,368 + gap),PAPER,2)
	if target_glow > 0.05:
		draw_arc(Vector2(640, 360), 15, 0, TAU, 32, Color(AMBER, target_glow * 0.8), 1.5, true)
	hud_objective()
	hud_tide()
	hud_vitals()
	minimap(Rect2(1090, 114 if touch else 80, 150, 104))
	if alarm_alpha > 0.01:
		ghost(Vector2(640, 108), "MACHINE HAS LINE OF SIGHT", T_SM, Color(WARM, alarm_alpha * (0.65 + 0.35 * sin(clock * 6.0))), true)
	if prompt_alpha > 0.01:
		hud_prompt()
	if not touch:
		if campaign.pulse_cooldown > 0:
			ghost(Vector2(1240 - 70, 700), "PULSE  %ds" % ceili(campaign.pulse_cooldown), T_SM, Color(PAPER, 0.6))
		if hints_alpha > 0.01:
			shade(600.0, 120.0, 0.30 * hints_alpha, false)
			ghost(Vector2(640, 702), "WASD  move      Mouse  look      Shift  run      E  use      Q  pulse      F  light      Tab  map      Esc  pause", T_SM, Color(PAPER, 0.88 * hints_alpha), true)
	else:
		draw_circle(stick_origin, 78, Color(INK, 0.28))
		draw_arc(stick_origin, 77, 0, TAU, 40, Color(PAPER, 0.22), 1.5)
		draw_circle(stick_origin + joystick * 52, 29, Color(PAPER, 0.35))
		if hints_alpha > 0.01:
			ghost(Vector2(124, 700), "MOVE", T_SM, Color(PAPER, 0.88 * hints_alpha), true)
			ghost(Vector2(1100, 436), "DRAG TO LOOK", T_SM, Color(PAPER, 0.88 * hints_alpha), true)
	hud_subtitle()

func hud_objective() -> void:
	# The new objective is announced, then settles into a single quiet line.
	var big := minf(obj_age / 0.6, 1.0) * clampf((7.0 - obj_age) / 0.9, 0.0, 1.0)
	var small := 0.62 * clampf((obj_age - 6.0) / 1.2, 0.0, 1.0)
	if big > 0.01:
		ghost(Vector2(MARGIN, 44), "OBJECTIVE", T_XS, Color(AMBER, big))
		ghost(Vector2(MARGIN, 72), obj_text, T_LG, Color(PAPER, big))
		var detail := "%d / 3 pumps     %d fuses     %d / 3 logs" % [campaign.pumps.count(true), campaign.fuse_count, campaign.logs.count(true)]
		ghost(Vector2(MARGIN, 96), detail, T_SM, Color(PAPER, 0.6 * big))
	if small > 0.01:
		draw_rect(Rect2(MARGIN, 40, 10, 2), Color(AMBER, small))
		ghost(Vector2(MARGIN + 18, 46), "%s    %d / 3" % [obj_text, campaign.pumps.count(true)], T_SM, Color(PAPER, small))

func hud_tide() -> void:
	var seconds := maxi(0, int(campaign.time_left))
	var urgent := seconds <= 90 and not campaign.assist
	var color := WARM if urgent else AMBER
	ghost(Vector2(640, 36), "EXPLORER" if campaign.assist else "TIDE", T_XS, Color(PAPER, 0.6), true)
	ghost(Vector2(640, 64), "%02d:%02d" % [seconds / 60, seconds % 60], T_XL, Color(color, 1.0 if not urgent else 0.75 + 0.25 * sin(clock * 4.0)), true)
	var water := clampf(1.0 - campaign.time_left / 480.0, 0.0, 1.0)
	draw_line(Vector2(580, 76), Vector2(700, 76), Color(PAPER, 0.18), 2)
	draw_line(Vector2(580, 76), Vector2(580 + 120 * water, 76), Color(color, 0.9), 2)

func hud_vitals() -> void:
	if vitals_alpha <= 0.01:
		return
	var y := 134.0 if touch else 128.0
	var low := campaign.health < 30.0
	ghost(Vector2(MARGIN, y + 4), "SUIT", T_XS, Color(PAPER, 0.6 * vitals_alpha))
	bar(Rect2(MARGIN + 44, y - 2, 96, 3), campaign.health / 100.0, Color(WARM if low else PAPER, 0.85 * vitals_alpha), vitals_alpha)
	ghost(Vector2(MARGIN, y + 22), "RUN", T_XS, Color(PAPER, 0.6 * vitals_alpha))
	bar(Rect2(MARGIN + 44, y + 16, 96, 3), campaign.stamina / 100.0, Color(AMBER, 0.85 * vitals_alpha), vitals_alpha)

func hud_prompt() -> void:
	var fsize := T_MD + 1
	var width := font.get_string_size(prompt_text, HORIZONTAL_ALIGNMENT_LEFT, -1, fsize).x
	var chip := 24.0 if (prompt_key and not touch) else 0.0
	var total := width + (chip + 10.0 if chip > 0.0 else 0.0)
	var x := 640.0 - total / 2.0
	var y := 404.0 + (1.0 - prompt_alpha) * 6.0
	if chip > 0.0:
		draw_rect(Rect2(x, y - 17, chip, chip), Color(INK, 0.45 * prompt_alpha))
		draw_rect(Rect2(x, y - 17, chip, chip), Color(AMBER, 0.9 * prompt_alpha), false, 1.0)
		text(Vector2(x + chip / 2.0, y), "E", T_SM, Color(AMBER, prompt_alpha), true)
		x += chip + 10.0
	ghost(Vector2(x, y), prompt_text, fsize, Color(PAPER if prompt_key else Color(PAPER, 0.7), prompt_alpha * (1.0 if prompt_key else 0.75)))

# One subtitle channel in the lower third: speaker, then the line.
func hud_subtitle() -> void:
	if radio_line.is_empty():
		return
	var alpha := minf(sub_age / 0.3, 1.0) * clampf(radio_time / 0.45, 0.0, 1.0)
	if alpha <= 0.01:
		return
	var who: String = radio_line[0]
	var rows := wrap_text(radio_line[1], 560.0, T_LG)
	shade(520.0, 200.0, 0.46 * alpha, false)
	var last := 668.0
	var first := last - 27.0 * (rows.size() - 1)
	var rise := (1.0 - alpha) * 4.0
	var speaker := Story.speaker_name(who) if not who.is_empty() else "FIELD NOTE"
	var color := Story.speaker_color(who) if not who.is_empty() else MUTED
	ghost(Vector2(640, first - 30 + rise), speaker, T_SM, Color(color, alpha), true)
	for i in range(rows.size()):
		ghost(Vector2(640, first + 27.0 * i + rise), rows[i], T_LG, Color(PAPER, alpha), true)

func wrap_text(value: String, width: float, size: int) -> Array:
	var rows := []
	var current := ""
	for word in value.split(" "):
		var candidate := current + (" " if not current.is_empty() else "") + word
		if font.get_string_size(candidate, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x > width and not current.is_empty():
			rows.append(current)
			current = word
		else:
			current = candidate
	rows.append(current)
	return rows

# Vertical gradient strip, dark at the screen edge.
func shade(top: float, height: float, alpha: float, from_top: bool) -> void:
	var edge := Color(0.01, 0.025, 0.03, alpha)
	var faded := Color(0.01, 0.025, 0.03, 0.0)
	var colors := PackedColorArray([edge, edge, faded, faded]) if from_top else PackedColorArray([faded, faded, edge, edge])
	var bottom := top + height
	draw_polygon(PackedVector2Array([Vector2(0, top), Vector2(1280, top), Vector2(1280, bottom), Vector2(0, bottom)]) if from_top else PackedVector2Array([Vector2(0, top), Vector2(1280, top), Vector2(1280, 720), Vector2(0, 720)]), colors)

# Text with a soft drop shadow so it stays legible over any scene.
func ghost(p: Vector2, value: String, size: int, color: Color, centered: bool = false) -> void:
	text(p + Vector2(0, 1.5), value, size, Color(0.0, 0.01, 0.015, color.a * 0.65), centered)
	text(p, value, size, color, centered)

func conversation() -> void:
	# Letterbox bars keep the speaker visible in the 3D view behind the subtitles.
	draw_rect(Rect2(0, 0, 1280, 84), Color(0.01, 0.03, 0.035, 0.92))
	var top := 375.0 if not dialogue_options.is_empty() else 520.0
	if touch and not dialogue_options.is_empty():
		top = 300.0
	draw_rect(Rect2(0, top - 40, 1280, 760 - top), Color(0.01, 0.03, 0.035, 0.86))
	if dialogue_line.is_empty():
		return
	var who: String = dialogue_line[0]
	text(Vector2(250, top - 6), Story.speaker_name(who), 15, Story.speaker_color(who))
	line(Vector2(250, top + 4), Vector2(1030, top + 4), Color(Story.speaker_color(who), 0.4))
	paragraph(Vector2(250, top + 36), dialogue_line[1], 780, 22, PAPER, 31)
	text(Vector2(640, 50), "MORROW QUAY  /  " + ("CHOOSE A REPLY" if not dialogue_options.is_empty() else ("TAP CONTINUE" if touch else "E OR SPACE TO CONTINUE   •   ESC TO END")), 12, MUTED, true)

func puzzle() -> void:
	heading(HarborData.PUMP_NAMES[puzzle_index], "MANUAL BYPASS / ONE CERAMIC FUSE WILL BE INSTALLED")
	text(Vector2(640, 248), "Rotate each valve to match its required outlet. Then energize the pump.", 17, MUTED, true)
	for i in range(3):
		var center := Vector2(420 + i * 220, 350)
		var matched: bool = dials[i] == HarborData.TARGETS[puzzle_index][i]
		var color := MINT if matched else AMBER
		draw_circle(center, 62, Color("1b3438"))
		draw_arc(center, 62, 0, TAU, 48, Color("58716b"), 2)
		for j in range(4):
			var direction := Vector2.from_angle(j * PI / 2 - PI / 2)
			line(center + direction * 43, center + direction * 54, color if j == dials[i] else Color("4d6863"), 3)
			text(center + direction * 80 + Vector2(0, 5), HarborData.DIRECTIONS[j], 12, MUTED, true)
		var vector := Vector2.from_angle(dials[i] * PI / 2 - PI / 2)
		line(center, center + vector * 41, color, 7)
		draw_circle(center, 10, PAPER)
		text(Vector2(center.x, 532 if touch else 506), "OUTLET " + HarborData.DIRECTIONS[HarborData.TARGETS[puzzle_index][i]], 20 if touch else 16, color, true)
	text(Vector2(640, 552 if touch else 540), puzzle_error if not puzzle_error.is_empty() else "MATCH THE MARKED OUTLETS TO RELEASE THE EMERGENCY HOLD", 13, AMBER, true)

func ending_screen() -> void:
	heading("THE QUAY HOLDS", "THREE PUMPS DRAWING / EVACUATION ROUTE RESTORED")
	text(Vector2(640, 270), "SERA / The water's below the clinic sill. You can stop now.", 22, PAPER, true)
	if ending.is_empty():
		paragraph(Vector2(250, 318), "The recovery report needs a destination. %d of 3 shift logs recovered.\nSending the full record exposes the missing interval; filing it with the recovery team keeps the work and testimony together. Neither brings the evacuated city back tonight." % campaign.logs.count(true), 780, 19, MUTED, 29)
	else:
		var outcome := "DAX / I've got the packet. Names, dates, the feeder decision. I'll call each person before I print it."
		if "dax_mismatch" in campaign.flags:
			outcome += " \"A municipal technician on site.\" Front page. Still true."
		elif "dax_protect" in campaign.flags:
			outcome += " Holt's name stays out. The ten seconds go in."
		if ending == "archive":
			outcome = "IVO / Put my feeder decision on the first page. The next shift needs it before they touch a switch."
			if "ivo_trust" in campaign.flags:
				outcome += " And go and sleep, Venn. That isn't advice."
		paragraph(Vector2(250, 322), outcome, 780, 22, PAPER, 32)
		# The two people Mara walked out last get the final word.
		var closing := []
		for id in ["evacuee_a", "evacuee_b"]:
			closing.append(Lore.EVACUEES[id].epilogue[ending])
		paragraph(Vector2(250, 428), "\n".join(closing), 780, 15, MUTED, 21)
		text(Vector2(640, 527), "RECORD SENT" if ending == "broadcast" else "RECORD FILED", 17, AMBER, true)
		text(Vector2(640, 551), "%d / 3 LOGS RECOVERED     •     %d / %d NOTICES READ     •     %d RESCUES     •     %02d:%02d TIDE REMAINING" % [campaign.logs.count(true), campaign.notes_read.count(true), Lore.NOTES.size(), campaign.rescues, int(campaign.time_left) / 60, int(campaign.time_left) % 60], 13, MUTED, true)
		text(Vector2(640, 576), "MORROW QUAY / END OF SHIFT", 14, PAPER, true)

func minimap(box: Rect2, detailed: bool = false) -> void:
	var k := 1.0 if detailed else map_alpha
	if k <= 0.01:
		return
	if detailed:
		panel(box.grow(6), 0.92)
	var factor := box.size / Vector2(2300, 1600)
	var land := Rect2(box.position + HarborData.BOUNDS.position * factor, HarborData.BOUNDS.size * factor)
	draw_rect(land, tint(Color("344b4a"), k))
	for building_box in HarborData.BUILDINGS:
		draw_rect(Rect2(box.position + building_box.position * factor, building_box.size * factor), tint(Color("677970"), k))
	draw_rect(Rect2(box.position + HarborData.CANAL.position * factor, HarborData.CANAL.size * factor), tint(INK, k))
	for bridge in HarborData.BRIDGES:
		draw_rect(Rect2(box.position + bridge.position * factor, bridge.size * factor), tint(Color("6c7f70"), k))
	for i in range(3):
		var p: Vector2 = box.position + HarborData.PUMPS[i] * factor
		draw_circle(p, 5 if detailed else 3, tint(MINT if campaign.pumps[i] else AMBER, k))
		if detailed:
			text(p + Vector2(10, 5), "P-0%d" % (i + 1), 12, PAPER)
		if not campaign.collected[i]:
			var f: Vector2 = box.position + HarborData.FUSES[i] * factor
			draw_polyline(PackedVector2Array([f + Vector2(0, -4), f + Vector2(4, 0), f + Vector2(0, 4), f + Vector2(-4, 0), f + Vector2(0, -4)]), tint(AMBER, k), 1.5)
		if detailed:
			var l: Vector2 = box.position + HarborData.LOGS[i] * factor
			draw_rect(Rect2(l - Vector2(2, 3), Vector2(5, 6)), tint(MUTED, k))
	for i in range(HarborData.NPC_IDS.size()):
		var person: Vector2 = box.position + HarborData.NPC_POSITIONS[i] * factor
		draw_circle(person, 3.5 if detailed else 2.5, tint(Story.speaker_color(HarborData.NPC_IDS[i]), k))
	var player_pos := box.position + campaign.position * factor
	draw_circle(player_pos, 5 if detailed else 4, tint(PAPER, k))
	line(player_pos,player_pos + Vector2(-sin(campaign.look_yaw),-cos(campaign.look_yaw))*13, tint(PAPER, k), 2)
	draw_arc(player_pos, 8 if detailed else 6, 0, TAU, 16, Color(PAPER, 0.3 * k), 1)
	var exit_pos := box.position + HarborData.EXIT * factor
	line(exit_pos - Vector2(4, 0), exit_pos + Vector2(4, 0), tint(PAPER, k), 2)
	line(exit_pos - Vector2(0, 4), exit_pos + Vector2(0, 4), tint(PAPER, k), 2)

func tint(c: Color, k: float) -> Color:
	return Color(c.r, c.g, c.b, c.a * k)

func compass(center: Vector2, radius: float) -> void:
	draw_arc(center, radius, 0, TAU, 64, Color(PAPER, 0.35), 1)
	draw_arc(center, radius - 12, 0, TAU, 64, Color(PAPER, 0.2), 1)
	for i in range(16):
		var direction := Vector2.from_angle(i * TAU / 16)
		line(center + direction * (radius - 4), center + direction * radius, Color(PAPER, 0.4), 1)
	draw_colored_polygon(PackedVector2Array([center + Vector2(0, -48), center + Vector2(-11, 8), center + Vector2(0, 2)]), AMBER)
	draw_colored_polygon(PackedVector2Array([center + Vector2(0, -48), center + Vector2(11, 8), center + Vector2(0, 2)]), PAPER)
	text(center + Vector2(0, -radius - 15), "N", 14, PAPER, true)
	text(center + Vector2(0, radius + 25), "S", 14, PAPER, true)

func panel(box: Rect2, opacity: float = 1.0) -> void:
	draw_rect(box, Color(INK, opacity))
	draw_rect(box, Color(0.46, 0.59, 0.53, 0.25), false, 1)

func bar(box: Rect2, amount: float, color: Color, k: float = 1.0) -> void:
	draw_rect(box, Color(PAPER, 0.16 * k) if k < 1.0 else Color("344c4b"))
	draw_rect(Rect2(box.position, Vector2(box.size.x * amount, box.size.y)), color)

func line(a: Vector2, b: Vector2, color: Color, width: float = 1.0) -> void:
	draw_line(a, b, color, width, true)

func text(p: Vector2, value: String, size: int, color: Color, centered: bool = false) -> void:
	var point := p
	if centered:
		point.x -= font.get_string_size(value, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x / 2
	draw_string(font, point, value, HORIZONTAL_ALIGNMENT_LEFT, -1, size, color)

func paragraph(p: Vector2, value: String, width: float, size: int, color: Color, spacing: float = 27) -> void:
	var y := p.y
	for raw in value.split("\n"):
		var current := ""
		for word in raw.split(" "):
			var candidate := current + (" " if not current.is_empty() else "") + word
			if font.get_string_size(candidate, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x > width and not current.is_empty():
				text(Vector2(p.x, y), current, size, color)
				y += spacing
				current = word
			else:
				current = candidate
		text(Vector2(p.x, y), current, size, color)
		y += spacing

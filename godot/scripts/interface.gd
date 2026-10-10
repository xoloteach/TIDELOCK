class_name HarborInterface
extends Control

signal command(action: String)
signal mode_changed
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
const INK := Color("102226")
const PAPER := Color("e6e4cc")
const MUTED := Color("94aba5")
const AMBER := Color("e2b46a")
const MINT := Color("8bbab0")

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	show_mode("title")

func _process(delta: float) -> void:
	clock += delta
	if mode == "playing":
		notice_time = maxf(0, notice_time - delta)
	queue_redraw()

func inform(text: String) -> void:
	notice = text.replace("[E]", "USE").replace("[Tab]", "LOG").replace("[Q]", "PULSE") if touch else text
	notice_time = 9.0

func show_mode(value: String) -> void:
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
	b.position = layout.position
	b.size = layout.size
	b.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	b.add_theme_font_override("font", font)
	b.add_theme_font_size_override("font_size", 20 if touch else 17)
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

func _draw() -> void:
	if mode == "playing":
		hud()
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
		"settings":
			heading("FIELD SETTINGS", "CHANGES APPLY IMMEDIATELY AND ARE SAVED LOCALLY")
			text(Vector2(431, 624 if touch else 538), "Explorer mode removes damage and stops the tide clock.", 14, MUTED)
		"credits":
			heading("END OF THE SHIFT SHEET", "TIDELOCK / GODOT HARBOR EDITION")
			paragraph(Vector2(300, 282), "Morrow Quay and its characters / TIDELOCK project\nModels & SFX / Kenney industrial, survival, impact, interface (CC0)\nConcrete / ambientCG Concrete030 (CC0)\nRain, water, interface and story / TIDELOCK source assets\nEngine / Godot 4.7.2, MIT licence\nField typeface / DejaVu Sans, Bitstream Vera licence\n\nSource code and asset licence notices accompany the web build.\nGodot engine licence: godotengine.org/license", 680, 17, PAPER, 28)
		"help":
			heading("RECOVERY MANUAL", "ONE QUAY / THREE PUMPS / ONE WAY HOME")
			var rows := [
				["01", "Find ceramic fuses in the amber supply boxes."],
				["02", "Carry a fuse to a pump. Match each rotary valve to its marked direction."],
				["03", "Avoid machine search cones. Walls block sight; pulse buys five seconds."],
				["04", "Restore all three pumps, then reach the east evacuation beacon."]
			]
			for i in range(rows.size()):
				text(Vector2(240, 267 + i * 59), rows[i][0], 23, AMBER)
				text(Vector2(290, 266 + i * 59), rows[i][1], 18, PAPER)
			line(Vector2(240, 482), Vector2(1040, 482), Color("4b6460"))
			paragraph(Vector2(240, 516), "Mouse: look    WASD: move    Shift: run    E: use    Q: pulse\nF: flashlight    Space: hop    Tab: map    Esc: pause    1 / 2 / 3: valves\nOn touch screens: left stick to move, swipe centre/right to look + USE / RUN / PULSE. Landscape recommended.", 800, 17, MUTED)
		"journal":
			heading("THE SHIFT RECORD", "MAP / RECOVERY STATUS / FIELD NOTES")
			minimap(Rect2(160, 225, 420, 315), true)
			for i in range(3):
				text(Vector2(635, 253 + i * 47), ("✓ " if campaign.pumps[i] else "○ ") + HarborData.PUMP_NAMES[i], 20, MINT if campaign.pumps[i] else AMBER)
			text(Vector2(635, 410), "THE MISSING 37 MINUTES", 17, PAPER)
			paragraph(Vector2(635, 440), "Recovered shift logs: %d / 3.\nPaper markers on the map hold accounts from Sera, Dax and Ivo. Read them before filing the recovery report." % campaign.logs.count(true), 490, 17, MUTED)
			text(Vector2(165, 575), "● MARA    ◇ FUSE    ○ PUMP    ▪ SHIFT LOG    + EVAC", 14, MUTED)
		"log":
			heading("RECOVERED SHIFT LOG", "PAPER RECORD / MORROW QUAY")
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

func hud() -> void:
	if hit_flash > 0:
		draw_rect(Rect2(0,0,1280,720),Color(0.9,0.22,0.10,hit_flash*0.16))
		draw_rect(Rect2(4,4,1272,712),Color(0.9,0.3,0.15,hit_flash),false,8)
	line(Vector2(632,360),Vector2(638,360),PAPER,2)
	line(Vector2(642,360),Vector2(648,360),PAPER,2)
	line(Vector2(640,352),Vector2(640,358),PAPER,2)
	line(Vector2(640,362),Vector2(640,368),PAPER,2)
	panel(Rect2(30, 25, 395, 113), 0.94)
	text(Vector2(50, 50), "BOROUGH RECOVERY  /  MARA VENN", 12, MUTED)
	text(Vector2(50, 81), ("Reach east evacuation" if campaign.pumps.count(true) == 3 else "Restore the flood defenses"), 22, PAPER)
	text(Vector2(50, 114), "%d / 3 PUMPS    •    %d FUSES    •    %d / 3 LOGS" % [campaign.pumps.count(true), campaign.fuse_count, campaign.logs.count(true)], 14, AMBER)
	panel(Rect2(462, 25, 270, 75), 0.94)
	text(Vector2(479, 49), "TIDE / " + ("EXPLORER" if campaign.assist else "TIME TO SURGE"), 11, MUTED)
	var seconds := maxi(0, int(campaign.time_left))
	text(Vector2(479, 82), "%02d:%02d" % [seconds / 60, seconds % 60], 26, AMBER if seconds > 90 else Color("ec9871"))
	var water := 1.0 - campaign.time_left / 480.0
	for i in range(20):
		draw_rect(Rect2(579 + i * 6, 64 - i * 0.6, 3, 16 + i * 0.6), AMBER if i < int(water * 20) else Color("3c5554"))
	minimap(Rect2(1020, 114 if touch else 84, 220, 142 if touch else 162))
	panel(Rect2(30, 158, 240, 59), 0.86)
	text(Vector2(48, 182), "SUIT", 12, MUTED)
	bar(Rect2(98, 173, 151, 7), campaign.health / 100.0, MINT)
	text(Vector2(48, 205), "RUN", 12, MUTED)
	bar(Rect2(98, 197, 151, 5), campaign.stamina / 100.0, AMBER)
	if campaign.alarm > 0.1:
		panel(Rect2(461, 112, 270, 39), 0.93)
		text(Vector2(596, 138), "MACHINE HAS LINE OF SIGHT", 12, Color("e59a76"), true)
	if not touch:
		panel(Rect2(30, 662, 665, 32), 0.90)
		text(Vector2(47, 683), "MOUSE LOOK   WASD MOVE   E USE   Q PULSE   F LIGHT   TAB MAP   ESC PAUSE", 12, MUTED)
		text(Vector2(1040, 680), "PULSE  " + ("READY" if campaign.pulse_cooldown <= 0 else "%ds" % ceili(campaign.pulse_cooldown)), 14, MINT)
	else:
		draw_circle(stick_origin, 78, Color(INK, 0.7))
		draw_arc(stick_origin, 77, 0, TAU, 40, Color(MUTED, 0.4), 2)
		draw_circle(stick_origin + joystick * 52, 29, Color(MINT, 0.65))
		text(Vector2(124, 693), "MOVE", 15, MUTED, true)
		text(stick_origin + Vector2(-61,7), "‹", 26, PAPER,true)
		text(stick_origin + Vector2(61,7), "›", 26, PAPER,true)
		text(Vector2(820,693), "DRAG RIGHT SIDE TO LOOK", 15, MUTED,true)
	var near := campaign.nearest()
	if not near.kind.is_empty():
		var hint: String = {"fuse": "RECOVER CERAMIC FUSE", "pump": "OPEN MANUAL PUMP PANEL", "log": "READ SHIFT LOG", "exit": "REACH EVACUATION BEACON"}[near.kind]
		if near.kind == "pump" and campaign.fuse_count == 0:
			hint = "PUMP NEEDS A FUSE / FIND AN AMBER BOX"
		panel(Rect2(375, 582, 530, 47), 0.95)
		text(Vector2(640, 612), ("USE  /  " if touch else "[E]  ") + hint, 16, PAPER, true)
	if notice_time > 0:
		panel(Rect2(340, 449, 600, 112), 0.94)
		text(Vector2(360, 474), "FIELD RADIO", 11, AMBER)
		paragraph(Vector2(360, 500), notice, 556, 16, PAPER, 23)

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
		if ending == "archive":
			outcome = "IVO / Put my feeder decision on the first page. The next shift needs it before they touch a switch."
		paragraph(Vector2(250, 340), outcome, 780, 24, PAPER, 36)
		text(Vector2(640, 464), "RECORD SENT" if ending == "broadcast" else "RECORD FILED", 17, AMBER, true)
		text(Vector2(640, 516), "%d / 3 LOGS RECOVERED     •     %d RESCUES     •     %02d:%02d TIDE REMAINING" % [campaign.logs.count(true), campaign.rescues, int(campaign.time_left) / 60, int(campaign.time_left) % 60], 14, MUTED, true)
		text(Vector2(640, 557), "MORROW QUAY / END OF SHIFT", 15, PAPER, true)

func minimap(box: Rect2, detailed: bool = false) -> void:
	panel(box.grow(6), 0.92)
	var factor := box.size / Vector2(2300, 1600)
	var land := Rect2(box.position + HarborData.BOUNDS.position * factor, HarborData.BOUNDS.size * factor)
	draw_rect(land, Color("344b4a"))
	for building_box in HarborData.BUILDINGS:
		draw_rect(Rect2(box.position + building_box.position * factor, building_box.size * factor), Color("677970"))
	draw_rect(Rect2(box.position + HarborData.CANAL.position * factor, HarborData.CANAL.size * factor), INK)
	for bridge in HarborData.BRIDGES:
		draw_rect(Rect2(box.position + bridge.position * factor, bridge.size * factor), Color("6c7f70"))
	for i in range(3):
		var p: Vector2 = box.position + HarborData.PUMPS[i] * factor
		draw_circle(p, 5 if detailed else 3, MINT if campaign.pumps[i] else AMBER)
		if detailed:
			text(p + Vector2(10, 5), "P-0%d" % (i + 1), 12, PAPER)
		if not campaign.collected[i]:
			var f: Vector2 = box.position + HarborData.FUSES[i] * factor
			draw_polyline(PackedVector2Array([f + Vector2(0, -4), f + Vector2(4, 0), f + Vector2(0, 4), f + Vector2(-4, 0), f + Vector2(0, -4)]), AMBER, 1.5)
		if detailed:
			var l: Vector2 = box.position + HarborData.LOGS[i] * factor
			draw_rect(Rect2(l - Vector2(2, 3), Vector2(5, 6)), MUTED)
	var player_pos := box.position + campaign.position * factor
	draw_circle(player_pos, 5 if detailed else 4, PAPER)
	line(player_pos,player_pos + Vector2(-sin(campaign.look_yaw),-cos(campaign.look_yaw))*13,PAPER,2)
	draw_arc(player_pos, 8 if detailed else 6, 0, TAU, 16, Color(PAPER, 0.3), 1)
	var exit_pos := box.position + HarborData.EXIT * factor
	line(exit_pos - Vector2(4, 0), exit_pos + Vector2(4, 0), MINT, 2)
	line(exit_pos - Vector2(0, 4), exit_pos + Vector2(0, 4), MINT, 2)

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

func bar(box: Rect2, amount: float, color: Color) -> void:
	draw_rect(box, Color("344c4b"))
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

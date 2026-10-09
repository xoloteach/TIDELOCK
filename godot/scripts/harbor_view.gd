class_name HarborView
extends Node2D

var campaign: Campaign
var camera := HarborData.START
var clock := 0.0
var reduced_motion := false
var menu := true
var damage_flash := 0.0
var font: Font = preload("res://fonts/FieldSans.ttf")
const WATER := Color("122b32")
const STONE := Color("354346")
const INK := Color("102226")
const PAPER := Color("d9ddcb")
const AMBER := Color("e2b46a")
const MINT := Color("8bbab0")

func _process(delta: float) -> void:
	clock += delta
	damage_flash = maxf(0, damage_flash - delta)
	var target := Vector2(1050, 800) if menu else campaign.position
	if menu and not reduced_motion:
		target += Vector2(sin(clock * 0.05) * 110, cos(clock * 0.04) * 70)
	camera = camera.lerp(target, 1.0 - exp(-delta * 5))
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0, 0, 1280, 720), WATER)
	draw_set_transform(Vector2(640, 360) - camera)
	# Water has slow bands rather than a flat background.
	for y in range(-200, 2000, 27):
		for x in range(-200, 2600, 120):
			var drift := sin(clock * 0.6 + y * 0.019 + x) * 18
			draw_line(Vector2(x + drift, y), Vector2(x + 55 + drift, y + 2), Color(0.27, 0.43, 0.45, 0.13), 1)
	# Island, quay retaining wall and service paving.
	draw_rect(HarborData.BOUNDS.grow(18), Color("17262b"))
	draw_rect(HarborData.BOUNDS.grow(6), Color("737971"))
	draw_rect(HarborData.BOUNDS, STONE)
	for y in range(180, 1380, 80):
		draw_line(Vector2(145, y), Vector2(2155, y), Color(0.65, 0.71, 0.66, 0.045), 1)
	for x in range(160, 2160, 120):
		draw_line(Vector2(x, 160), Vector2(x, 1380), Color(0.65, 0.71, 0.66, 0.04), 1)
	# Asphalt service roads and faded lane paint.
	for road in [Rect2(160, 570, 1220, 80), Rect2(1120, 350, 300, 500), Rect2(210, 1170, 1750, 120)]:
		draw_rect(road, Color("2c3a3d"))
	for x in range(230, 1970, 85):
		draw_line(Vector2(x, 1230), Vector2(x + 33, 1230), Color(0.77, 0.73, 0.52, 0.35), 3)
	for x in range(210, 1380, 80):
		draw_line(Vector2(x, 610), Vector2(x + 28, 610), Color(0.77, 0.73, 0.52, 0.30), 3)
	# Floodwater channels. Bridges share the exact collision data.
	draw_rect(HarborData.CANAL.grow(7), Color("889286"))
	draw_rect(HarborData.CANAL, WATER)
	for i in range(18):
		var x := 1400 + i * 42
		draw_line(Vector2(x, 655 + sin(clock + i) * 6), Vector2(x + 20, 656 + sin(clock + i) * 6), Color("3b565b"), 2)
	for bridge in HarborData.BRIDGES:
		draw_rect(bridge, Color("52625e"))
		for y in range(int(bridge.position.y), int(bridge.end.y), 12):
			draw_line(Vector2(bridge.position.x, y), Vector2(bridge.end.x, y), Color("394847"), 2)
		draw_line(bridge.position, Vector2(bridge.position.x, bridge.end.y), AMBER.darkened(0.3), 5)
		draw_line(Vector2(bridge.end.x, bridge.position.y), bridge.end, AMBER.darkened(0.3), 5)
	# Puddles, drainage gratings and bollards.
	for i in range(40):
		var p := Vector2(210 + fmod(i * 237.0, 1850), 190 + fmod(i * 193.0, 1140))
		if not HarborData.blocked(p, 35, true):
			draw_set_transform(Vector2(640, 360) - camera + p, 0, Vector2(2.1, 0.65))
			draw_circle(Vector2.ZERO, 13 + i % 12, Color(0.1, 0.2, 0.23, 0.42))
			draw_set_transform(Vector2(640, 360) - camera)
	for x in range(170, 2160, 115):
		for y in [175, 1365]:
			draw_circle(Vector2(x + 3, y + 4), 9, Color(0, 0, 0, 0.25))
			draw_circle(Vector2(x, y), 6, Color("879289"))
	# Warehouses have visible roof ribs, skylights and storm-weathered paint.
	for i in range(HarborData.BUILDINGS.size()):
		building(HarborData.BUILDINGS[i], i)
	# Dock cranes over the water, along the north sea wall.
	for x in [430, 980, 1810]:
		draw_line(Vector2(x, 170), Vector2(x - 60, 45), Color("172126"), 13)
		draw_line(Vector2(x - 60, 45), Vector2(x + 190, 35), Color("172126"), 12)
		draw_line(Vector2(x - 56, 49), Vector2(x + 177, 38), Color("b19666"), 3)
		draw_line(Vector2(x + 160, 40), Vector2(x + 160, 123), Color("637575"), 2)
		draw_arc(Vector2(x + 164, 123), 7, 0, PI * 1.6, 12, Color("a4aaa0"), 2)
	# Small moored work boats and rope ties.
	for x in [470, 1000, 1740]:
		var hull := PackedVector2Array([Vector2(x - 55, 1450), Vector2(x + 55, 1450), Vector2(x + 75, 1510), Vector2(x, 1545), Vector2(x - 75, 1510)])
		draw_colored_polygon(hull, Color("6c746a"))
		draw_polyline(hull, Color("bdc0a3"), 3)
		draw_rect(Rect2(x - 26, 1470, 52, 32), Color("27383b"))
		draw_line(Vector2(x, 1450), Vector2(x - 40, 1370), Color("998e70"), 2)
	for i in range(3):
		pump(i)
		if not campaign.collected[i]:
			fuse(HarborData.FUSES[i], i)
		logbook(HarborData.LOGS[i], campaign.logs[i])
	# Gate and illuminated evacuation point.
	var unlocked := campaign.pumps.count(true) == 3
	var gate_color := MINT if unlocked else AMBER
	draw_rect(Rect2(2015, 1080, 38, 280), Color("172b2e"))
	if not unlocked:
		for y in range(1090, 1350, 22):
			draw_line(Vector2(2020, y), Vector2(2048, y + 16), gate_color, 4)
	else:
		draw_line(Vector2(2020, 1090), Vector2(2048, 1106), gate_color, 4)
	draw_circle(HarborData.EXIT, 44, Color(gate_color, 0.07))
	draw_arc(HarborData.EXIT, 32, 0, TAU, 32, gate_color, 2)
	draw_line(HarborData.EXIT + Vector2(0, -16), HarborData.EXIT + Vector2(0, 16), gate_color, 3)
	draw_line(HarborData.EXIT + Vector2(-16, 0), HarborData.EXIT + Vector2(16, 0), gate_color, 3)
	label(HarborData.EXIT + Vector2(-58, 65), "EVAC / EAST", 13, gate_color)
	label(Vector2(290, 600), "MORROW QUAY  /  SERVICE ROAD", 18, Color("7b8880"))
	label(Vector2(320, 1280), "← DEPOT     NORTH WEIR ↑     EAST DOCK →", 14, Color("889283"))
	for drone in campaign.drones:
		draw_drone(drone)
	if not menu:
		player()
	# Screen-space rain, corner vignette, storm darkness.
	draw_set_transform(Vector2.ZERO)
	if not reduced_motion:
		for i in range(85):
			var p := Vector2(fmod(i * 193.0 + clock * 48, 1340) - 30, fmod(i * 137.0 + clock * 410, 780) - 30)
			draw_line(p, p + Vector2(-8, 22), Color(0.7, 0.82, 0.81, 0.09), 1)
	for i in range(6):
		var opacity := 0.015 + i * 0.003
		var width := (6 - i) * 17
		draw_rect(Rect2(0, 0, width, 720), Color(0.015, 0.035, 0.04, opacity))
		draw_rect(Rect2(1280 - width, 0, width, 720), Color(0.015, 0.035, 0.04, opacity))
	if damage_flash > 0:
		draw_rect(Rect2(0, 0, 1280, 720), Color(0.85, 0.23, 0.12, damage_flash * 0.22))

func building(box: Rect2, index: int) -> void:
	var container := index >= 3
	var roof: Color = [Color("626c67"), Color("5e655a"), Color("586b70"), Color("876d53")][index % 4]
	draw_rect(Rect2(box.position + Vector2(12, 20), box.size), Color(0.02, 0.07, 0.09, 0.40))
	draw_rect(box, Color("182c30"))
	draw_rect(Rect2(box.position + Vector2(0, -14), box.size), roof)
	draw_rect(Rect2(box.position + Vector2(0, -14), box.size), roof.lightened(0.13), false, 2)
	for x in range(int(box.position.x + 10), int(box.end.x), 14 if container else 35):
		draw_line(Vector2(x, box.position.y - 12), Vector2(x, box.end.y - 16), roof.darkened(0.14), 2)
	if not container:
		for x in range(int(box.position.x + 30), int(box.end.x - 30), 85):
			draw_rect(Rect2(x, box.position.y + 70, 42, 65), Color("304b50"))
			draw_rect(Rect2(x + 2, box.position.y + 72, 38, 61), Color("78918b"), false, 1)
			draw_line(Vector2(x + 21, box.position.y + 70), Vector2(x + 21, box.position.y + 135), Color("506963"), 2)
		label(box.position + Vector2(30, 45), ["07  /  BOROUGH STORES", "CLINIC FEEDER", "EAST DOCK / FREIGHT"][index], 17, PAPER.darkened(0.14))
		draw_rect(Rect2(box.position.x + 45, box.end.y - 5, 65, 7), AMBER.darkened(0.5))
	else:
		label(box.position + Vector2(12, 29), "MQ / %02d" % (index + 11), 12, PAPER.darkened(0.1))

func pump(index: int) -> void:
	var p: Vector2 = HarborData.PUMPS[index]
	var color := MINT if campaign.pumps[index] else AMBER
	draw_line(p + Vector2(-75, 0), p + Vector2(70, 0), Color("1c3033"), 17)
	draw_line(p + Vector2(-75, -3), p + Vector2(70, -3), Color("6c7b72"), 6)
	for x in [-58, 52]:
		draw_line(p + Vector2(x, -10), p + Vector2(x, 10), Color("99a28f"), 3)
	draw_circle(p + Vector2(5, 7), 37, Color(0, 0, 0, 0.3))
	draw_circle(p, 34, Color("162c31"))
	draw_arc(p, 31, 0, TAU, 32, Color("889582"), 4)
	draw_circle(p, 24, Color("4c625e"))
	var angle := clock * 1.8 if campaign.pumps[index] else 0.0
	for j in range(3):
		var spoke := Vector2.from_angle(angle + j * TAU / 3)
		draw_line(p + spoke * 7, p + spoke * 21, color.darkened(0.2), 7)
	draw_circle(p, 7, Color("193538"))
	draw_rect(Rect2(p + Vector2(33, -37), Vector2(25, 37)), Color("172a2e"))
	draw_circle(p + Vector2(45, -25), 4, color)
	label(p + Vector2(-74, -49), HarborData.PUMP_NAMES[index], 13, color)
	label(p + Vector2(-40, 58), "DRAWING" if campaign.pumps[index] else "MANUAL HOLD", 11, color)

func fuse(p: Vector2, index: int) -> void:
	draw_rect(Rect2(p + Vector2(-20, -18), Vector2(40, 36)), Color("786d4f"))
	draw_rect(Rect2(p + Vector2(-20, -18), Vector2(40, 36)), AMBER.darkened(0.4), false, 2)
	draw_rect(Rect2(p + Vector2(-12, -8), Vector2(24, 16)), Color("1c3033"))
	draw_line(p + Vector2(-6, 0), p + Vector2(6, 0), PAPER, 5)
	draw_circle(p + Vector2(-8, 0), 3, AMBER)
	draw_circle(p + Vector2(8, 0), 3, AMBER)
	label(p + Vector2(-28, 34), "FUSE %02d" % (index + 1), 11, AMBER)
	if not menu:
		draw_arc(p, 29 + sin(clock * 2) * 2, -PI * 0.2, PI * 1.2, 24, Color(AMBER, 0.4), 1)

func logbook(p: Vector2, read: bool) -> void:
	draw_rect(Rect2(p + Vector2(-14, -12), Vector2(28, 24)), Color("1c3033"))
	draw_rect(Rect2(p + Vector2(-10, -8), Vector2(20, 16)), PAPER.darkened(0.3 if read else 0.0))
	for y in [-4, 0, 4]:
		draw_line(p + Vector2(-6, y), p + Vector2(6, y), Color("526460"), 1)
	label(p + Vector2(-30, 31), "FILED" if read else "SHIFT LOG", 10, MINT)

func draw_drone(drone: Dictionary) -> void:
	var p: Vector2 = drone.position
	var angle: float = drone.heading.angle()
	var color := Color("d68d68") if drone.alert > 0.2 else Color("d5c79d")
	if drone.stun <= 0:
		var cone := PackedVector2Array([p])
		for j in range(17):
			cone.append(p + Vector2.from_angle(angle - 0.72 + j * 0.09) * 245)
		draw_colored_polygon(cone, Color(color, 0.035 + drone.alert * 0.10))
		draw_arc(p, 245, angle - 0.72, angle + 0.72, 24, Color(color, 0.16), 1)
	draw_circle(p + Vector2(6, 10), 21, Color(0, 0, 0, 0.3))
	draw_set_transform(Vector2(640, 360) - camera + p, angle)
	for y in [-17, 13]:
		draw_rect(Rect2(-21, y, 40, 6), Color("102125"))
	draw_rect(Rect2(-18, -13, 36, 26), Color("879184"))
	draw_rect(Rect2(-13, -10, 26, 20), Color("526663"))
	draw_line(Vector2(-6, 0), Vector2(19, 0), Color("c7c6a7"), 4)
	draw_circle(Vector2(17, 0), 4, MINT if drone.stun > 0 else color)
	draw_set_transform(Vector2(640, 360) - camera)
	if drone.stun > 0:
		draw_arc(p, 30, clock * 2, clock * 2 + PI * 1.5, 20, MINT, 2)
	elif drone.alert > 0.05:
		draw_rect(Rect2(p + Vector2(-20, -37), Vector2(40, 4)), INK)
		draw_rect(Rect2(p + Vector2(-20, -37), Vector2(40 * drone.alert, 4)), color)

func player() -> void:
	var p := campaign.position
	if campaign.invulnerable > 0 and int(clock * 8) % 2 == 0:
		return
	draw_circle(p + Vector2(4, 8), 16, Color(0, 0, 0, 0.35))
	var angle := campaign.heading.angle() + PI / 2
	draw_set_transform(Vector2(640, 360) - camera + p, angle)
	var stride := sin(clock * 14) * 3 if Input.is_action_pressed("move_up") or Input.is_action_pressed("move_down") or Input.is_action_pressed("move_left") or Input.is_action_pressed("move_right") else 0.0
	draw_line(Vector2(-5, 5), Vector2(-5, 13 + stride), Color("142b30"), 6)
	draw_line(Vector2(5, 5), Vector2(5, 13 - stride), Color("142b30"), 6)
	draw_circle(Vector2.ZERO, 13, Color("1c3639"))
	draw_colored_polygon(PackedVector2Array([Vector2(-12, 6), Vector2(-11, -6), Vector2(-6, -11), Vector2(6, -11), Vector2(11, -6), Vector2(12, 6)]), Color("c19b5c"))
	draw_line(Vector2(-7, 4), Vector2(7, 4), Color("e6c788"), 3)
	draw_circle(Vector2(0, -6), 7, Color("253d40"))
	draw_arc(Vector2(0, -6), 6, PI, TAU, 12, Color("d5b986"), 3)
	draw_line(Vector2(10, -2), Vector2(15, -8), MINT, 3)
	draw_set_transform(Vector2(640, 360) - camera)
	if campaign.pulse_ring > 0:
		draw_arc(p, (1 - campaign.pulse_ring) * 270, 0, TAU, 64, Color(MINT, campaign.pulse_ring * 0.8), 3)
	# Small directional compass toward the next actual mission target.
	var target := HarborData.EXIT
	for i in range(3):
		if not campaign.pumps[i]:
			target = HarborData.PUMPS[i]
			if campaign.fuse_count == 0:
				var closest := INF
				for j in range(3):
					if not campaign.collected[j] and p.distance_to(HarborData.FUSES[j]) < closest:
						closest = p.distance_to(HarborData.FUSES[j])
						target = HarborData.FUSES[j]
			break
	if p.distance_to(target) > 100:
		var d := p.direction_to(target)
		var tip := p + d * 53
		var side := d.orthogonal() * 5
		draw_colored_polygon(PackedVector2Array([tip + d * 7, tip - d * 4 + side, tip - d * 4 - side]), Color(AMBER, 0.8))

func label(p: Vector2, text: String, size: int, color: Color) -> void:
	draw_string(font, p, text, HORIZONTAL_ALIGNMENT_LEFT, -1, size, color)

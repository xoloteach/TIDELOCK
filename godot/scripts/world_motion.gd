class_name WorldMotion
extends Node3D

# Small living details layered over the quay: fake pools of lamplight on the wet
# paving (the only local light in low quality), halos on the lamp heads, pump
# status pools, one shared wind that leans the rain, gulls and a failing sign.
const FLICKER := "mmnmmommommnonmmonqnmmo"
# Lamp posts and the direction each lamp arm reaches over the walkway.
const LAMPS := [
	[Vector2(240, 950), Vector2(1, 0)], [Vector2(610, 810), Vector2(-1, 0)],
	[Vector2(1300, 604), Vector2(0, 1)], [Vector2(1700, 820), Vector2(-1, 0)],
	[Vector2(2110, 1050), Vector2(0, -1)],
]
# Which pump sector powers each lamp; -1 is on the depot supply and stays lit.
const LAMP_SECTOR := [-1, 0, 1, 2, -1]
const SECURITY := [Vector2(545, 590), Vector2(1100, 850), Vector2(1745, 550)]
const GULLS := [
	[Vector3(20, 9, -1), 6.0, 2.2], [Vector3(6, 12, -2), 8.0, 2.0],
	[Vector3(37, 7, 30), 5.0, 1.8], [Vector3(47, 10, 14), 7.0, 2.4],
]

var view: FirstPersonView
var wind := 0.6
var gradient: GradientTexture2D
var lamp_pools: Array[MeshInstance3D] = []
var lamp_halos: Array[MeshInstance3D] = []
var lamp_lights: Array[OmniLight3D] = []
var pump_pools: Array[MeshInstance3D] = []
var sign_label: Label3D
var gulls: Array[Dictionary] = []
var beacons: Array[Node3D] = []
var beacon_lenses: Array[MeshInstance3D] = []

func setup(owner_view: FirstPersonView) -> void:
	view = owner_view
	gradient = GradientTexture2D.new()
	gradient.fill = GradientTexture2D.FILL_RADIAL
	gradient.fill_from = Vector2(0.5, 0.5)
	gradient.fill_to = Vector2(1.0, 0.5)
	gradient.width = 64
	gradient.height = 64
	var ramp := Gradient.new()
	ramp.offsets = PackedFloat32Array([0.0, 0.5, 1.0])
	ramp.colors = PackedColorArray([Color(1, 1, 1, 1), Color(1, 1, 1, 0.35), Color(1, 1, 1, 0)])
	gradient.gradient = ramp
	for lamp in LAMPS:
		var head: Vector2 = lamp[0] + lamp[1] * HarborEdge.LAMP_REACH
		lamp_pools.append(glow_quad(view.world(head, 0.015), 6.0, Color("ffd398"), 0.35, false))
		lamp_halos.append(glow_quad(view.world(head, 3.35), 0.9, Color("ffcb88"), 0.5, true))
	for p in SECURITY:
		glow_quad(view.world(p, 0.015), 7.0, Color("e8f0ff"), 0.25, false)
	glow_quad(view.world(Vector2(2060, 1200), 0.015), 6.0, Color("fff3d6"), 0.3, false)
	for i in range(3):
		pump_pools.append(glow_quad(view.world(HarborData.PUMPS[i] + Vector2(0, 35), 0.02), 2.0, Color("dda94c"), 0.25, false))
	# The lamp OmniLights are created by the view; claim them so they can flicker.
	for child in view.get_children():
		if child is OmniLight3D and child.omni_range == 5.0:
			lamp_lights.append(child)
	puddles()
	for i in range(view.pumps.size()):
		pump_station(view.pumps[i])
	if not view.low_quality:
		for spec in GULLS:
			gulls.append(gull(spec))

func glow_quad(at: Vector3, size: float, tint: Color, strength: float, billboard: bool) -> MeshInstance3D:
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	mat.disable_fog = true
	mat.albedo_texture = gradient
	mat.albedo_color = Color(tint.r * strength, tint.g * strength, tint.b * strength, 1.0)
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	var quad := MeshInstance3D.new()
	if billboard:
		mat.billboard_mode = BaseMaterial3D.BILLBOARD_ENABLED
		var mesh := QuadMesh.new()
		mesh.size = Vector2(size, size)
		quad.mesh = mesh
	else:
		var mesh := PlaneMesh.new()
		mesh.size = Vector2(size, size)
		quad.mesh = mesh
	quad.material_override = mat
	quad.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	quad.position = at
	quad.set_meta("tint", tint)
	quad.set_meta("strength", strength)
	add_child(quad)
	return quad

func set_glow(quad: MeshInstance3D, tint: Color, strength: float) -> void:
	var mat: StandardMaterial3D = quad.material_override
	mat.albedo_color = Color(tint.r * strength, tint.g * strength, tint.b * strength, 1.0)

func gull(spec: Array) -> Dictionary:
	var root := Node3D.new()
	add_child(root)
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = Color("cfd5d4")
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	var body := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = Vector3(0.07, 0.07, 0.3)
	body.mesh = box
	body.material_override = mat
	root.add_child(body)
	var wings: Array[Node3D] = []
	for side in [-1.0, 1.0]:
		var pivot := Node3D.new()
		root.add_child(pivot)
		var wing := MeshInstance3D.new()
		var plane := QuadMesh.new()
		plane.size = Vector2(0.42, 0.12)
		wing.mesh = plane
		wing.material_override = mat
		wing.rotation.x = -PI / 2
		wing.position = Vector3(side * 0.21, 0, 0)
		pivot.add_child(wing)
		pivot.set_meta("side", side)
		wings.append(pivot)
	return {"root": root, "wings": wings, "centre": spec[0], "radius": spec[1], "speed": spec[2],
		"angle": randf() * TAU, "phase": randf() * TAU}

func flicker_at(time: float) -> float:
	return float(FLICKER.unicode_at(int(time * 10.0) % FLICKER.length()) - 97) / 12.0

func update(delta: float, elapsed: float) -> void:
	var still := view.reduced_motion
	wind = 0.6 + 0.4 * sin(elapsed * 0.21) * sin(elapsed * 0.057 + 1.3)
	view.rain.direction = Vector3(-0.08 - wind * 0.10, -1, 0.03)
	var e := 1.0 if still else flicker_at(elapsed)
	for i in range(LAMPS.size()):
		var sector: int = LAMP_SECTOR[i]
		var level := 1.0 if sector < 0 or view.campaign.pumps[sector] else e
		set_glow(lamp_pools[i], Color("ffd398"), 0.35 * level)
		set_glow(lamp_halos[i], Color("ffcb88"), 0.5 * level)
		if i < lamp_lights.size():
			lamp_lights[i].light_energy = 1.4 * level
	for i in range(3):
		var running: bool = view.campaign.pumps[i]
		set_glow(pump_pools[i], Color("77dbc1") if running else Color("dda94c"), 0.3 if running else 0.25)
	if sign_label:
		var steady := view.campaign.pumps.count(true) >= 3
		var level := 1.2 if steady or still else 0.3 + flicker_at(elapsed * 0.7 + 3.0) * 0.9
		sign_label.modulate = Color("ffb64a") * Color(level, level, level, 1.0)
	for i in range(beacons.size()):
		var running: bool = view.campaign.pumps[i]
		beacons[i].rotation.y += delta * (5.0 if running and not still else 0.0)
		var lens: StandardMaterial3D = beacon_lenses[i].material_override
		lens.emission = Color("77dbc1") if running else Color("dda94c")
		lens.albedo_color = lens.emission
		lens.emission_energy_multiplier = 2.2 if running else 0.5 + 0.5 * e
	for g in gulls:
		g.angle += g.speed / g.radius * delta
		var a: float = g.angle
		g.root.position = g.centre + Vector3(cos(a) * g.radius, sin(elapsed * 0.4 + g.phase) * 0.8, sin(a) * g.radius)
		g.root.rotation = Vector3(0, -a, 0.25)
		var flapping: bool = not still and fmod(elapsed + g.phase, 6.0) < 2.0
		var beat := 0.6 * sin(elapsed * 9.0 + g.phase) if flapping else 0.08
		for pivot in g.wings:
			pivot.rotation.z = beat * float(pivot.get_meta("side"))

# Standing water in the low spots of the paving, kept off buildings, pumps and paths
# the player must read clearly. Seeded so every run lays the same puddles.
func puddles() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 1931
	var placed := 0
	var shader := preload("res://shaders/puddle.gdshader")
	for attempt in range(400):
		if placed >= (14 if view.low_quality else 34):
			break
		var p := Vector2(rng.randf_range(180, 2120), rng.randf_range(200, 1340))
		if HarborData.blocked(p, 70.0) or HarborData.CANAL.grow(60).has_point(p):
			continue
		var near_pump := false
		for pump in HarborData.PUMPS:
			if p.distance_to(pump) < 120:
				near_pump = true
		if near_pump:
			continue
		var mat := ShaderMaterial.new()
		mat.shader = shader
		mat.set_shader_parameter("seed", rng.randf() * 50.0)
		mat.set_shader_parameter("ripples", 0.0 if view.reduced_motion else 1.0)
		var quad := MeshInstance3D.new()
		var plane := PlaneMesh.new()
		plane.size = Vector2(rng.randf_range(1.2, 3.2), rng.randf_range(0.9, 2.2))
		quad.mesh = plane
		quad.material_override = mat
		quad.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		quad.position = view.world(p, 0.012)
		quad.rotation.y = rng.randf() * TAU
		quad.visibility_range_end = 30.0
		add_child(quad)
		placed += 1

func cylinder(parent: Node3D, radius: float, height: float, at: Vector3, mat: Material, sides: int = 12) -> MeshInstance3D:
	var mesh := CylinderMesh.new()
	mesh.top_radius = radius
	mesh.bottom_radius = radius
	mesh.height = height
	mesh.radial_segments = sides
	mesh.rings = 1
	var node := MeshInstance3D.new()
	node.mesh = mesh
	node.material_override = mat
	node.position = at
	parent.add_child(node)
	return node

# Each pump becomes a working station: a plinth, intake and outflow pipework, an
# electrical cabinet, hazard bollards and a beacon that turns once the pump runs.
func pump_station(pump: Node3D) -> void:
	var concrete := view.material(Color("5d6462"))
	var pipe := view.material(Color("41545a"))
	var rust := view.material(Color("6b4a35"))
	var hazard := view.material(Color("d9a33f"))
	var black := view.material(Color("1b1f20"))
	var cabinet := view.material(Color("8a9493"))
	for mat in [pipe, cabinet]:
		mat.roughness = 0.45
		mat.metallic = 0.6
	# Everything stays within the pump's 0.9 m collision circle so nothing clips Mara.
	view.box(pump, Vector3(1.4, 0.14, 1.3), Vector3(0, 0.07, 0), concrete)
	view.box(pump, Vector3(1.44, 0.02, 0.05), Vector3(0, 0.15, 0.63), hazard)
	# Intake and outflow pipes leave the tank and drop through the plinth.
	for side in [-1.0, 1.0]:
		var run := cylinder(pump, 0.1, 0.32, Vector3(side * 0.5, 0.42, -0.1), pipe)
		run.rotation.z = PI / 2
		cylinder(pump, 0.14, 0.07, Vector3(side * 0.4, 0.42, -0.1), rust).rotation.z = PI / 2
		cylinder(pump, 0.1, 0.36, Vector3(side * 0.64, 0.3, -0.1), pipe)
		cylinder(pump, 0.14, 0.05, Vector3(side * 0.64, 0.16, -0.1), rust)
	for slot in range(4):
		view.box(pump, Vector3(0.36, 0.02, 0.025), Vector3(-0.38, 0.145, 0.25 + slot * 0.08), black)
	# Electrical cabinet with a warning plate and a cable run to the tank.
	view.box(pump, Vector3(0.42, 1.05, 0.28), Vector3(0.4, 0.66, -0.5), cabinet)
	view.box(pump, Vector3(0.006, 0.86, 0.006), Vector3(0.4, 0.66, -0.355), black)
	view.box(pump, Vector3(0.15, 0.13, 0.01), Vector3(0.4, 0.95, -0.355), hazard)
	# Rear corner bollards, yellow with a black band.
	for x in [-0.6, 0.6]:
		cylinder(pump, 0.06, 0.8, Vector3(x, 0.54, -0.56), hazard, 10)
		cylinder(pump, 0.062, 0.1, Vector3(x, 0.7, -0.56), black, 10)
	# Beacon on the tank: a lit lens with a turning reflector inside.
	cylinder(pump, 0.1, 0.06, Vector3(0, 1.23, -0.05), black)
	var lens_mat := StandardMaterial3D.new()
	lens_mat.emission_enabled = true
	lens_mat.emission = Color("dda94c")
	lens_mat.albedo_color = Color("dda94c")
	var lens := cylinder(pump, 0.075, 0.14, Vector3(0, 1.33, -0.05), lens_mat)
	beacon_lenses.append(lens)
	var vane := Node3D.new()
	vane.position = Vector3(0, 1.33, -0.05)
	pump.add_child(vane)
	view.box(vane, Vector3(0.16, 0.1, 0.012), Vector3.ZERO, black)
	beacons.append(vane)

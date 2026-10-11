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
		var head: Vector2 = lamp[0] + lamp[1] * 27.5
		lamp_pools.append(glow_quad(view.world(head, 0.015), 6.0, Color("ffd398"), 0.35, false))
		lamp_halos.append(glow_quad(view.world(head, 3.55), 0.9, Color("ffcb88"), 0.5, true))
	for p in SECURITY:
		glow_quad(view.world(p, 0.015), 7.0, Color("e8f0ff"), 0.25, false)
	glow_quad(view.world(Vector2(2060, 1200), 0.015), 6.0, Color("fff3d6"), 0.3, false)
	for i in range(3):
		pump_pools.append(glow_quad(view.world(HarborData.PUMPS[i] + Vector2(0, 35), 0.02), 2.0, Color("dda94c"), 0.25, false))
	# The lamp OmniLights are created by the view; claim them so they can flicker.
	for child in view.get_children():
		if child is OmniLight3D and child.omni_range == 5.0:
			lamp_lights.append(child)
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
	for g in gulls:
		g.angle += g.speed / g.radius * delta
		var a: float = g.angle
		g.root.position = g.centre + Vector3(cos(a) * g.radius, sin(elapsed * 0.4 + g.phase) * 0.8, sin(a) * g.radius)
		g.root.rotation = Vector3(0, -a, 0.25)
		var flapping: bool = not still and fmod(elapsed + g.phase, 6.0) < 2.0
		var beat := 0.6 * sin(elapsed * 9.0 + g.phase) if flapping else 0.08
		for pivot in g.wings:
			pivot.rotation.z = beat * float(pivot.get_meta("side"))

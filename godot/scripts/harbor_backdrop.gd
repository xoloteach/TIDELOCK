class_name HarborBackdrop
extends Node3D

# The world beyond the quay: far sea, West Terminal, mainland skyline, harbour light, freighters
# and buoys. Everything static is baked into one mesh with at most five surfaces (city, industrial
# and watercraft atlases, flat vertex colour, far sea). Only things that move, blink or glow are
# separate nodes. Coordinates are metres; y of the sea plane is -0.42.

const SHORE_TOP := 0.5
const LIGHT_POS := Vector3(66, 14.5, -38)
const FREIGHTER_POS := Vector3(30, -2.6, 66)
const FREIGHTER_YAW := 70.0
const FLASH_COLOR := Color("aebccb")

var view: FirstPersonView
var environment: Environment
var fog_base := Color.WHITE
var skyline_mat: ShaderMaterial
var lit := 0.02
var beam_holder: Node3D
var lantern_mat: StandardMaterial3D
var beacons: Array[Dictionary] = []
var mast_mats: Array[StandardMaterial3D] = []
var ship_anchor: Node3D
var horn: AudioStreamPlayer3D
var horn_timer := 30.0
var horn_glow := 0.0
var buoys: Array[Dictionary] = []
var bell: AudioStreamPlayer3D
var bell_cooldown := 0.0
var bell_roll := 0.0
var last_flash := 0.0
var tools: Dictionary = {}
var textures: Dictionary = {}

func water_y(p: Vector3) -> float:
	# Matches water.gdshader so buoys ride the same waves.
	var t := fmod(Time.get_ticks_msec() * 0.001, 3600.0)
	return -0.42 + sin(p.x * 1.3 + p.z * 0.55 + t * 1.05) * 0.045 + sin(p.z * 2.1 - p.x * 0.7 - t * 1.4) * 0.023

# The shared wind lives in WorldMotion so rain, gulls and buoys move together.
func wind_now() -> float:
	return view.motion.wind

# ---------------------------------------------------------------- bake helpers

func bucket(key: String) -> SurfaceTool:
	if not tools.has(key):
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		tools[key] = st
	return tools[key]

# Append any primitive mesh with a flat vertex colour (the "color" and "sea" buckets).
func prim(key: String, mesh: Mesh, xf: Transform3D, color: Color) -> void:
	var st := bucket(key)
	var arrays := mesh.surface_get_arrays(0)
	var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	var norms: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL]
	var idx: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
	var nb := xf.basis.inverse().transposed()
	for i in idx:
		st.set_color(color)
		st.set_normal((nb * norms[i]).normalized())
		st.set_uv(Vector2.ZERO)
		st.add_vertex(xf * verts[i])

func add_box(size: Vector3, centre: Vector3, color: Color, yaw_degrees: float = 0.0, parent: Transform3D = Transform3D.IDENTITY, key: String = "color") -> void:
	var unit := BoxMesh.new()
	var local := Transform3D(Basis(Vector3.UP, deg_to_rad(yaw_degrees)) * Basis.from_scale(size), centre)
	prim(key, unit, parent * local, color)

# A box of the given thickness running from a to b (stay cables).
func add_beam(a: Vector3, b: Vector3, thickness: float, color: Color, parent: Transform3D) -> void:
	var dir := b - a
	var basis := Basis.looking_at(dir.normalized(), Vector3.UP) * Basis.from_scale(Vector3(thickness, thickness, dir.length()))
	prim("color", BoxMesh.new(), parent * Transform3D(basis, (a + b) * 0.5), color)

func add_cylinder(bottom: float, top: float, height: float, centre: Vector3, color: Color, segments: int = 12) -> void:
	var cyl := CylinderMesh.new()
	cyl.bottom_radius = bottom
	cyl.top_radius = top
	cyl.height = height
	cyl.radial_segments = segments
	cyl.rings = 1
	prim("color", cyl, Transform3D(Basis.IDENTITY, centre), color)

# Fit a Kenney GLB to a size in its own axes (long axis on Z), then yaw and place it. The meshes
# go straight into a bucket; the instantiated scene is freed.
func add_model(key: String, path: String, size: Vector3, at: Vector3, yaw_degrees: float = 0.0) -> void:
	var scene: Node3D = (load("res://assets/%s.glb" % path) as PackedScene).instantiate()
	var parts: Array = []
	var bounds := AABB()
	var found := false
	for mi: MeshInstance3D in scene.find_children("*", "MeshInstance3D", true, false):
		var xf := Transform3D.IDENTITY
		var n: Node = mi
		while n != scene and n != null:
			xf = (n as Node3D).transform * xf
			n = n.get_parent()
		var b: AABB = xf * mi.get_aabb()
		bounds = bounds.merge(b) if found else b
		found = true
		parts.append([mi, xf])
	var fit_scale := size / bounds.size
	var fit := Transform3D(Basis.from_scale(fit_scale), Vector3(-bounds.get_center().x, -bounds.position.y, -bounds.get_center().z) * fit_scale)
	var place := Transform3D(Basis(Vector3.UP, deg_to_rad(yaw_degrees)), at)
	var st := bucket(key)
	for part in parts:
		var mi: MeshInstance3D = part[0]
		for s in range(mi.mesh.get_surface_count()):
			st.append_from(mi.mesh, s, place * fit * part[1])
			var mat := mi.get_active_material(s)
			if not textures.has(key) and mat is BaseMaterial3D and mat.albedo_texture:
				textures[key] = mat.albedo_texture
	scene.free()

func atlas_material(key: String) -> Material:
	var tex: Texture2D = textures.get(key)
	if key == "skyline":
		skyline_mat = ShaderMaterial.new()
		skyline_mat.shader = preload("res://shaders/skyline.gdshader")
		skyline_mat.set_shader_parameter("palette", tex)
		return skyline_mat
	if not view.low_quality:
		var worn := ShaderMaterial.new()
		worn.shader = preload("res://shaders/weathered.gdshader")
		worn.set_shader_parameter("palette", tex)
		return worn
	var m := StandardMaterial3D.new()
	m.albedo_texture = tex
	m.albedo_color = Color(0.6, 0.64, 0.66)   # storm-dull the Kenney palette
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	m.roughness = 0.85
	m.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
	return m

func vertex_material() -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.vertex_color_use_as_albedo = true
	m.vertex_color_is_srgb = true
	m.roughness = 0.85
	m.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
	return m

func glow_material(color: Color, energy: float, no_fog: bool = false) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.emission_enabled = true
	m.emission = color
	m.emission_energy_multiplier = energy
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.disable_fog = no_fog
	return m

func glow_sphere(mat: Material, radius: float, at: Vector3, parent: Node3D = self) -> MeshInstance3D:
	var sphere := SphereMesh.new()
	sphere.radius = radius
	sphere.height = radius * 2.0
	sphere.radial_segments = 8
	sphere.rings = 4
	var node := MeshInstance3D.new()
	node.mesh = sphere
	node.material_override = mat
	node.position = at
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(node)
	return node

# ---------------------------------------------------------------- build

func build(owner_view: FirstPersonView) -> void:
	view = owner_view
	environment = view.environment
	fog_base = environment.fog_light_color
	build_sea_frame()
	build_apron()
	build_shore()
	build_skyline()
	build_cranes()
	build_ships()
	build_harbor_light()
	commit_mesh()
	build_beacons()
	build_buoys()
	horn_timer = randf_range(25.0, 60.0)

func build_sea_frame() -> void:
	# Four quads round the 130x110 m sea plane, tucked 1 m under it. Hides its edge, gives a horizon.
	var color := Color("0f2226")
	var y := -0.47
	for r in [Rect2(-200, -200, 161, 440), Rect2(89, -200, 161, 440), Rect2(-40, -200, 130, 164), Rect2(-40, 72, 130, 168)]:
		var plane := PlaneMesh.new()
		plane.size = r.size
		prim("sea", plane, Transform3D(Basis.IDENTITY, Vector3(r.get_center().x, y, r.get_center().y)), color)

func build_apron() -> void:
	# West Terminal: a 30 x 60 m concrete apron, algae-green quay face below the waterline.
	add_box(Vector3(30, 0.3, 60), Vector3(-14, -0.1, 15), Color("55605f"))
	add_box(Vector3(29.8, 2.4, 59.8), Vector3(-14, -1.4, 15), Color("1d2b25"))
	# Containers on the apron (real 20 ft boxes), long axis on x; tier height 2.6 m.
	var stacks := [[-8, 6, 0], [-8, 6, 1], [-8, 9, 0], [-8, 12, 0], [-8, 12, 1], [-16, 20, 0], [-16, 23, 0], [-16, 23, 1], [-16, 26, 0]]
	var names := ["a", "b", "c"]
	for i in range(stacks.size()):
		var s: Array = stacks[i]
		add_model("industrial", "industrial/shipping-container-" + names[i % 3], Vector3(2.4, 2.6, 6.0), Vector3(s[0], 0.05 + s[2] * 2.6, s[1]), 90.0)
	add_model("industrial", "industrial/water-tower", Vector3(2.5, 8, 2.5), Vector3(-5, 0.05, 2))

func build_shore() -> void:
	var color := Color("1d2629")
	# North strip and east strip; deeper than the plan's so the gaps between towers read as land.
	add_box(Vector3(220, 1.5, 61), Vector3(50, SHORE_TOP - 0.75, -89.5), color)
	add_box(Vector3(50, 1.5, 180), Vector3(135, SHORE_TOP - 0.75, -30), color)
	add_model("industrial", "industrial/chimney-large", Vector3(3, 24, 3), Vector3(112, SHORE_TOP, -24))

func build_skyline() -> void:
	var north := [
		["a", -14, 8, 8, 14], ["c", -4, 9, 9, 22], ["wide-a", 8, 14, 7, 10], ["h", 19, 8, 8, 26],
		["d", 28, 9, 9, 16], ["j", 37, 8, 8, 30], ["wide-b", 49, 14, 7, 12], ["b", 60, 9, 9, 24],
		["g", 70, 8, 8, 18], ["l", 80, 9, 9, 34], ["m", 91, 8, 8, 20], ["i", 102, 10, 10, 15],
	]
	for e in north:
		add_model("skyline", "city/low-detail-building-" + e[0], Vector3(e[2], e[4], e[3]), Vector3(e[1], SHORE_TOP, -66))
	# East row at x 117 (wide pieces turned 90 degrees so they face the strait). The power-station
	# base moves 2 m east so it does not swallow the relocated chimney.
	var east := [
		["c", -50, 9, 9, 26, 0], ["wide-a", -38, 14, 7, 11, 90], ["k", -24, 9, 9, 9, 0], ["h", -8, 9, 9, 28, 0],
		["d", 6, 9, 9, 16, 0], ["wide-b", 20, 14, 7, 12, 90], ["k", 34, 9, 9, 10, 0], ["a", 48, 8, 8, 14, 0],
	]
	for e in east:
		var x := 119.0 if e[0] == "k" and e[1] == -24 else 117.0
		add_model("skyline", "city/low-detail-building-" + e[0], Vector3(e[2], e[4], e[3]), Vector3(x, SHORE_TOP, e[1]), e[5])

func build_cranes() -> void:
	var rust := Color("a8452f")
	var dark := Color("6e2d20")
	for z in [12.0, 30.0]:
		var at := Transform3D(Basis.IDENTITY, Vector3(-24, 0.05, z))
		for sx in [-5.0, 5.0]:
			for sz in [-4.0, 4.0]:
				add_box(Vector3(0.8, 26, 0.8), Vector3(sx, 13, sz), rust, 0.0, at)
		for sz in [-4.0, 4.0]:
			add_box(Vector3(11, 1.2, 1.2), Vector3(0, 26, sz), rust, 0.0, at)
		for sx in [-5.0, 5.0]:
			add_box(Vector3(1.2, 1.2, 9), Vector3(sx, 26, 0), rust, 0.0, at)
		add_box(Vector3(50, 1.4, 1.8), Vector3(-11, 28.5, 0), rust, 0.0, at)
		add_box(Vector3(5, 3, 6), Vector3(4, 30.5, 0), dark, 0.0, at)
		add_box(Vector3(1, 14, 1), Vector3(3, 33, 0), rust, 0.0, at)
		add_beam(Vector3(3, 40, 0), Vector3(-36, 29, 0), 0.3, dark, at)
		add_beam(Vector3(3, 40, 0), Vector3(14, 29, 0), 0.3, dark, at)

func build_ships() -> void:
	# Moored freighter alongside the apron; anchored freighter to the south.
	add_model("watercraft", "watercraft/ship-cargo-c", Vector3(13, 8.6, 36), Vector3(-36, -2.2, 22))
	add_model("watercraft", "watercraft/ship-cargo-a", Vector3(14, 12, 38), FREIGHTER_POS, FREIGHTER_YAW)

func build_harbor_light() -> void:
	add_box(Vector3(44, 2.1, 4), Vector3(88, -0.45, -38), Color("3a4543"))
	var base := Vector3(66, SHORE_TOP + 0.1, -38)
	add_cylinder(1.6, 1.1, 13.0, base + Vector3(0, 6.5, 0), Color("d7d9d2"))
	for y: float in [4.0, 9.0]:
		var r0 := 1.6 - 0.5 * ((y - 0.6) / 13.0) + 0.03
		var r1 := 1.6 - 0.5 * ((y + 0.6) / 13.0) + 0.03
		add_cylinder(r0, r1, 1.2, base + Vector3(0, y, 0), Color("b33a2e"))
	add_cylinder(1.6, 1.6, 0.2, base + Vector3(0, 13.1, 0), Color("2b3033"))
	var cap := CylinderMesh.new()
	cap.top_radius = 0.0
	cap.bottom_radius = 1.0
	cap.height = 1.0
	cap.radial_segments = 12
	cap.rings = 1
	prim("color", cap, Transform3D(Basis.IDENTITY, base + Vector3(0, 15.1, 0)), Color("b33a2e"))

func commit_mesh() -> void:
	var mesh := ArrayMesh.new()
	for key in ["skyline", "industrial", "watercraft", "color", "sea"]:
		if not tools.has(key):
			continue
		var mat: Material
		if key == "color":
			mat = vertex_material()
		elif key == "sea":
			var sea := StandardMaterial3D.new()
			sea.albedo_color = Color("0f2226")
			sea.roughness = 0.25
			sea.metallic = 0.25
			sea.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
			mat = sea
		else:
			mat = atlas_material(key)
		(tools[key] as SurfaceTool).commit(mesh)
		mesh.surface_set_material(mesh.get_surface_count() - 1, mat)
	var node := MeshInstance3D.new()
	node.mesh = mesh
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(node)
	tools.clear()

func build_beacons() -> void:
	# Aviation and crane beacons blink; the harbour lantern pulses with the sweep.
	var red := glow_material(Color("ff2e1f"), 3.0, true)
	var spots := [Vector3(80, SHORE_TOP + 34.5, -66), Vector3(117, SHORE_TOP + 28.5, -8), Vector3(-21, 40.5, 12), Vector3(-21, 40.5, 30)]
	for i in range(spots.size()):
		var radius := 0.7 if i < 2 else 0.45
		beacons.append({"node": glow_sphere(red, radius, spots[i]), "offset": i * 0.37})
	lantern_mat = glow_material(Color("ffe7b0"), 2.5, true)
	var lantern := CylinderMesh.new()
	lantern.top_radius = 0.8
	lantern.bottom_radius = 0.8
	lantern.height = 1.4
	lantern.radial_segments = 10
	lantern.rings = 1
	var lamp := MeshInstance3D.new()
	lamp.mesh = lantern
	lamp.material_override = lantern_mat
	lamp.position = LIGHT_POS
	lamp.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(lamp)
	if not view.low_quality:
		var beam_mat := ShaderMaterial.new()
		beam_mat.shader = preload("res://shaders/beam.gdshader")
		beam_holder = Node3D.new()
		beam_holder.position = LIGHT_POS
		add_child(beam_holder)
		for side in [1.0, -1.0]:
			var cone := CylinderMesh.new()
			cone.top_radius = 0.35
			cone.bottom_radius = 4.5
			cone.height = 38.0
			cone.radial_segments = 12
			cone.rings = 1
			cone.cap_top = false
			cone.cap_bottom = false
			var beam := MeshInstance3D.new()
			beam.mesh = cone
			beam.material_override = beam_mat
			beam.rotation.z = side * PI / 2.0
			beam.position = Vector3(side * 19.0, 0, 0)
			beam.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			beam_holder.add_child(beam)
	# Mast lights on the anchored freighter, in ship-local metres.
	ship_anchor = Node3D.new()
	ship_anchor.position = FREIGHTER_POS
	ship_anchor.rotation.y = deg_to_rad(FREIGHTER_YAW)
	add_child(ship_anchor)
	for entry in [[Color("fff3d6"), Vector3(0, 11.5, -14)], [Color("ff3b2f"), Vector3(0, 10, 16)]]:
		var mat := glow_material(entry[0], 2.5)
		mast_mats.append(mat)
		glow_sphere(mat, 0.25, entry[1], ship_anchor)
	horn = view.sound3d(preload("res://assets/audio/ship_horn_synth.ogg"), ship_anchor, -4.0, 200.0, false)
	horn.unit_size = 25.0

func build_buoys() -> void:
	var specs := [
		["watercraft/buoy-flag", Vector3(1.0, 2.9, 1.4), Vector3(48.4, 0, 12.0), Color(1.0, 0.55, 0.5)],
		["watercraft/buoy-flag", Vector3(1.0, 2.9, 1.4), Vector3(48.4, 0, 16.0), Color(0.5, 1.0, 0.65)],
		["watercraft/buoy", Vector3(1.0, 2.0, 1.0), Vector3(18.0, 0, -8.0), Color.WHITE],
	]
	for i in range(specs.size()):
		var s: Array = specs[i]
		var holder := view.model(s[0], s[1], s[2], self)
		for mesh: MeshInstance3D in holder.find_children("*", "MeshInstance3D", true, false):
			if view.low_quality:
				mesh.visibility_range_end = 18.0
			if s[3] != Color.WHITE:
				var tinted: StandardMaterial3D = mesh.get_active_material(0).duplicate()
				tinted.albedo_color = s[3]
				mesh.set_surface_override_material(0, tinted)
		buoys.append({"node": holder, "phase": i * 2.1, "bell": i == 2})
		if i == 2:
			bell = view.sound3d(preload("res://assets/audio/buoy_bell.ogg"), holder, -10.0, 60.0, false)

# ---------------------------------------------------------------- motion

func tick(delta: float, flicker: float) -> void:
	var e := view.elapsed
	var speed := 0.15 if view.reduced_motion else 0.35
	var campaign := view.campaign
	# A7: the city wakes as pumps come back.
	var pumps_back := campaign.pumps.count(true) if campaign != null else 0
	lit = move_toward(lit, 0.02 + 0.025 * pumps_back, delta * 0.05)
	skyline_mat.set_shader_parameter("lit", lit)
	# A4: harbour-light sweep and lantern pulse.
	var dir := Vector3.RIGHT
	if beam_holder != null:
		beam_holder.rotation.y += delta * speed
		dir = Vector3.RIGHT.rotated(Vector3.UP, beam_holder.rotation.y)
	else:
		view_sweep += delta * speed
		dir = Vector3.RIGHT.rotated(Vector3.UP, view_sweep)
	var to_camera := view.eyes.global_position - LIGHT_POS
	to_camera.y = 0.0
	var facing := absf(dir.dot(to_camera.normalized())) if to_camera.length() > 0.01 else 0.0
	lantern_mat.emission_energy_multiplier = 2.0 + 1.5 * facing
	# A5: blinking beacons.
	for b in beacons:
		b.node.visible = fmod(e + b.offset, 1.6) < 0.18
	# A8: lightning lights the fog (the skyline silhouettes against it).
	if not is_equal_approx(flicker, last_flash):
		last_flash = flicker
		environment.fog_light_color = fog_base.lerp(FLASH_COLOR, flicker * 0.55)
	# Buoys ride the waves.
	var wind := wind_now()
	for b in buoys:
		var node: Node3D = b.node
		var p := node.position
		node.position.y = water_y(p) - 0.53
		var swing := 0.08 if b.bell else 0.03
		var roll := sin(e * 0.7 + b.phase) * swing * (1.0 + wind)
		node.rotation.z = roll
		node.rotation.x = sin(e * 0.9 + b.phase) * 0.02
		if b.bell:
			bell_cooldown -= delta
			if bell_roll < 0.0 and roll >= 0.0 and wind > 0.7 and bell_cooldown <= 0.0 and sound_ok():
				bell_cooldown = 3.0
				bell.play()
			bell_roll = roll
	# A9: the anchored freighter sounds its horn now and then; mast lights flare with it.
	horn_glow = maxf(0.0, horn_glow - delta)
	if not view.menu and view.focus_npc < 0:
		horn_timer -= delta
		if horn_timer <= 0.0:
			horn_timer = randf_range(75.0, 140.0)
			horn_glow = 4.0
			if sound_ok():
				horn.play()
	for m in mast_mats:
		m.emission_energy_multiplier = 5.0 if horn_glow > 0.0 else 2.5

var view_sweep := 0.0

func sound_ok() -> bool:
	return view.sound_enabled and DisplayServer.get_name() != "headless"

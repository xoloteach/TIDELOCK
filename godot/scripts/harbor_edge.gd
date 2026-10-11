class_name HarborEdge
extends Node3D

# The harbour's edge and its emergency: coping, seaward quay face, bollards,
# ladders, moored boats and the tide-lock gate; canal walls, kerbs, chain
# railings, the culvert and drifting debris; vehicles, barriers, sandbags,
# pallets and the jib crane; storm wrack, litter and the five street lamps.
# Nothing here adds collision except the footprints in HarborData, and no
# light is added except the existing lamp OmniLights (high quality only).

const S := 50.0
# Bollards sit on the coping, inside the 15-unit band the player can never enter.
const BOLLARDS := [
	Vector2(260, 163), Vector2(500, 163), Vector2(800, 163), Vector2(1040, 163),
	Vector2(1300, 163), Vector2(1600, 163), Vector2(1840, 163), Vector2(2080, 163),
	Vector2(300, 1377), Vector2(560, 1377), Vector2(820, 1377), Vector2(1120, 1377),
	Vector2(1500, 1377), Vector2(1760, 1377), Vector2(1960, 1377),
]
const BOLLARD_RADIUS := 0.18
# Ladders hang off the seaward face, clear of the wave-burst emitters and fenders.
const LADDERS := [Vector2(560, 160), Vector2(1320, 160), Vector2(1740, 160), Vector2(640, 1380), Vector2(1460, 1380)]
# Chain railings line the canal, broken where the two bridges land.
const RAIL_RUNS := [Vector2(1400, 1570), Vector2(1700, 1940), Vector2(2070, 2145)]
const RAIL_ROWS := [637.0, 763.0]
# Tide-lock gate at the canal mouth: two piers, a beam and a leaf that drops.
const GATE_PIERS := [Vector2(2163, 615), Vector2(2163, 785)]
const GATE_LEAF_X := 2165.0
# Street lamps: post position and the walkway direction (the plan's arm direction).
# street_lamp_01 is a post-top lantern with no arm: its lantern sits on the post
# axis at about 3.3 m, so the head is the post itself (LAMP_REACH 0). Posts stay at
# the original lamp positions so none of them stands in a bridge exit.
const LAMPS := [
	[Vector2(240, 950), Vector2(1, 0)], [Vector2(610, 810), Vector2(-1, 0)],
	[Vector2(1300, 604), Vector2(0, 1)], [Vector2(1700, 820), Vector2(-1, 0)],
	[Vector2(2110, 1050), Vector2(0, -1)],
]
const LAMP_REACH := 0.0
const JIB_CRANE := Vector2(2120, 200)
const WRACK := [
	Vector2(320, 1356), Vector2(470, 1356), Vector2(620, 1356), Vector2(770, 1356), Vector2(1160, 1356),
	Vector2(1520, 1356), Vector2(1660, 1356), Vector2(1800, 1356), Vector2(1940, 1356),
	Vector2(260, 184), Vector2(400, 184), Vector2(560, 184), Vector2(1080, 184), Vector2(1340, 184),
	Vector2(1600, 184), Vector2(1760, 184), Vector2(2020, 184),
]
const LITTER_PLANKS := [
	[Vector2(380, 960), 20.0], [Vector2(395, 975), 35.0], [Vector2(720, 1250), -10.0],
	[Vector2(1150, 1210), 70.0], [Vector2(1720, 1180), 15.0], [Vector2(1735, 1195), 40.0],
	[Vector2(1380, 230), -25.0], [Vector2(2050, 400), 5.0],
]
const CANAL_BRIDGE_SPANS := [Vector2(31.6, 33.8), Vector2(39.0, 41.2)]
const DRIFT_START := 29.4
const DRIFT_END := 42.9

var view: FirstPersonView
var low := false
var stone: StandardMaterial3D
var painted: StandardMaterial3D
var floaters: Array[Dictionary] = []
var boats: Array[Dictionary] = []
var leaf: Node3D
var leaf_sound: AudioStreamPlayer3D
var gate_down := false
var prev_restored := -1
var prev_menu := true
var gate_drop := 0.0
var culvert_flow: CPUParticles3D
var culvert_foam: MeshInstance3D
var culvert_sound: AudioStreamPlayer3D
var culvert_on := false
var hook_pivot: Node3D
var wind := 0.6
var ticks := 0

static func m(p: Vector2, height: float = 0.0) -> Vector3:
	return Vector3(p.x / S, height, p.y / S)

# Matches water.gdshader so floating things ride the same waves.
static func water_y(p: Vector3) -> float:
	var t := fmod(Time.get_ticks_msec() * 0.001, 3600.0)
	return -0.42 + sin(p.x * 1.3 + p.z * 0.55 + t * 1.05) * 0.045 + sin(p.z * 2.1 - p.x * 0.7 - t * 1.4) * 0.023

# ---------------------------------------------------------------- mesh helpers

func vc_material(roughness: float = 0.75) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	mat.vertex_color_is_srgb = true
	mat.roughness = roughness
	if low:
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
	return mat

func flat(color: Color, glow: float = 0.0) -> StandardMaterial3D:
	var mat := view.material(color, glow)
	if not low:
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_PER_PIXEL
	return mat

func tri(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, na: Vector3, nb: Vector3, nc: Vector3, color: Color) -> void:
	# Godot's front faces satisfy (b - a) x (c - a) = -normal; swap if needed.
	if (b - a).cross(c - a).dot(na + nb + nc) > 0.0:
		var t := b
		b = c
		c = t
		var tn := nb
		nb = nc
		nc = tn
	st.set_color(color)
	st.set_normal(na)
	st.add_vertex(a)
	st.set_normal(nb)
	st.add_vertex(b)
	st.set_normal(nc)
	st.add_vertex(c)

func add_box(st: SurfaceTool, size: Vector3, centre: Vector3, basis: Basis = Basis(), color: Color = Color.WHITE) -> void:
	var h := size * 0.5
	for axis in 3:
		for sgn in [-1.0, 1.0]:
			var n := Vector3.ZERO
			n[axis] = sgn
			var u := Vector3.ZERO
			u[(axis + 1) % 3] = h[(axis + 1) % 3]
			var v := Vector3.ZERO
			v[(axis + 2) % 3] = h[(axis + 2) % 3]
			var f := n * h[axis]
			var p := [f - u - v, f + u - v, f + u + v, f - u + v]
			for i in 4:
				p[i] = centre + basis * p[i]
			var wn := (basis * n).normalized()
			tri(st, p[0], p[1], p[2], wn, wn, wn, color)
			tri(st, p[0], p[2], p[3], wn, wn, wn, color)

# Vertical cylinder (or cone) from base.y to base.y + height.
func add_cylinder(st: SurfaceTool, r0: float, r1: float, height: float, base: Vector3, sides: int, color: Color, caps: bool = true) -> void:
	for i in sides:
		var a0 := TAU * i / sides
		var a1 := TAU * (i + 1) / sides
		var d0 := Vector3(cos(a0), 0, sin(a0))
		var d1 := Vector3(cos(a1), 0, sin(a1))
		var slope := (r0 - r1) / height
		var n0 := (d0 + Vector3(0, slope, 0)).normalized()
		var n1 := (d1 + Vector3(0, slope, 0)).normalized()
		var b0 := base + d0 * r0
		var b1 := base + d1 * r0
		var t0 := base + d0 * r1 + Vector3(0, height, 0)
		var t1 := base + d1 * r1 + Vector3(0, height, 0)
		tri(st, b0, b1, t1, n0, n1, n1, color)
		tri(st, b0, t1, t0, n0, n1, n0, color)
		if caps:
			var top := base + Vector3(0, height, 0)
			tri(st, top, t0, t1, Vector3.UP, Vector3.UP, Vector3.UP, color)
			tri(st, base, b1, b0, Vector3.DOWN, Vector3.DOWN, Vector3.DOWN, color)

func begin() -> SurfaceTool:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	return st

func finish(st: SurfaceTool, mat: Material, parent: Node3D = self, range_end: float = 0.0) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	node.mesh = st.commit()
	node.material_override = mat
	if range_end > 0.0:
		node.visibility_range_end = range_end
	parent.add_child(node)
	return node

# E1: many boxes sharing one material become one draw call.
# parts: [size: Vector3, centre: Vector3, yaw_rad: float, (optional) color]
func baked(parts: Array, mat: Material, parent: Node3D = self, range_end: float = 0.0) -> MeshInstance3D:
	var st := begin()
	for part in parts:
		add_box(st, part[0], part[1], Basis(Vector3.UP, part[2]), part[3] if part.size() > 3 else Color.WHITE)
	return finish(st, mat, parent, range_end)

# E1: repeated small meshes as one MultiMesh per ~8 m chunk, culled at 18 m in low quality.
func scatter(mesh: Mesh, xforms: Array, mat: Material) -> void:
	var chunks := {}
	for t: Transform3D in xforms:
		var key := Vector2i(floori(t.origin.x / 8.0), floori(t.origin.z / 8.0))
		if not chunks.has(key):
			chunks[key] = []
		chunks[key].append(t)
	for list in chunks.values():
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.mesh = mesh
		mm.instance_count = list.size()
		for i in list.size():
			mm.set_instance_transform(i, list[i])
		var node := MultiMeshInstance3D.new()
		node.multimesh = mm
		node.material_override = mat
		node.visibility_range_end = near_range()
		add_child(node)

func near_range() -> float:
	return 18.0 if low else 60.0

func cull(root: Node) -> void:
	for mesh in root.find_children("*", "MeshInstance3D", true, false):
		mesh.visibility_range_end = near_range()

# A Poly Haven prop centred on `at` after a tilt (tyres laid flat, a barrel on its side).
func tilted(file: String, parent: Node3D, at: Vector3, yaw: float, tilt: Vector3) -> Node3D:
	var root := Node3D.new()
	parent.add_child(root)
	root.position = at
	root.rotation.y = yaw
	var pivot := Node3D.new()
	root.add_child(pivot)
	view.prop_local(file, pivot, Vector3.ZERO, 0.0)
	pivot.rotation = tilt
	var b := view.bounds_of(root)
	pivot.position = -Vector3(b.get_center().x, b.position.y, b.get_center().z)
	root.set_meta("height", b.size.y)
	return root

func glb_mesh(path: String) -> Array:
	var scene: Node3D = load(path).instantiate()
	var mesh_node: MeshInstance3D = scene.find_children("*", "MeshInstance3D", true, false)[0]
	var mesh: Mesh = mesh_node.mesh
	var mat: Material = mesh_node.get_active_material(0).duplicate()
	if low and mat is StandardMaterial3D:
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
		mat.normal_enabled = false
	scene.free()
	return [mesh, mat]

# ---------------------------------------------------------------- build

func build(owner_view: FirstPersonView) -> void:
	view = owner_view
	low = view.low_quality
	stone = vc_material(0.85)
	if not low:
		stone.albedo_texture = preload("res://assets/concrete/Color.jpg")
		stone.uv1_triplanar = true
		stone.uv1_scale = Vector3(0.7, 0.7, 0.7)
	else:
		stone.albedo_color = Color(0.85, 0.86, 0.85)
	painted = vc_material(0.6)
	build_stone()
	build_bollards()
	build_ladders()
	build_boats()
	build_gate()
	build_railings()
	build_culvert()
	build_debris()
	build_set_pieces()
	build_sandbags()
	build_pallets()
	build_crane()
	build_wrack()
	build_litter()
	build_lamps()

# Coping, seaward face, canal retaining walls, kerbs, gate piers, culvert headwall: one call.
func build_stone() -> void:
	var st := begin()
	var cope := Color("9aa09a")
	var hazard := Color("ffcf5a") if not low else Color("dfa949")
	var face := Color("5b625f")
	var algae := Color("1d2b25")
	# 3.1 Coping on the inner bands of the old steel walls, 0.45 m tall.
	for r: Rect2 in [Rect2(140, 160, 2020, 12), Rect2(140, 1368, 2020, 12), Rect2(140, 172, 12, 1196),
			Rect2(2148, 172, 12, 458), Rect2(2148, 770, 12, 598)]:
		add_box(st, Vector3(r.size.x / S, 0.45, r.size.y / S), m(r.get_center(), 0.225), Basis(), cope)
	# Hazard strip along the inner top edge, 0.12 m wide and 0.02 m proud.
	for strip: Rect2 in [Rect2(146, 166, 2008, 6), Rect2(146, 1368, 2008, 6), Rect2(146, 172, 6, 1196),
			Rect2(2148, 172, 6, 458), Rect2(2148, 770, 6, 598)]:
		add_box(st, Vector3(strip.size.x / S, 0.02, strip.size.y / S), m(strip.get_center(), 0.46), Basis(), hazard)
	# 3.2 Seaward quay face, 0.35 m thick, from +0.45 m down; algae below -0.25 m. The water
	# plane is opaque, so faces stop at -0.9 m (below the deepest wave trough) to save fill.
	var faces := [
		Rect2(2.45, 2.85, 41.1, 0.35), Rect2(2.45, 27.6, 41.1, 0.35), Rect2(2.45, 3.2, 0.35, 24.4),
		Rect2(43.2, 3.2, 0.35, 9.4), Rect2(43.2, 15.4, 0.35, 12.2),
	]
	# 4.1 Canal retaining walls inside the canal rect, from 0 m down into the water.
	var walls := [Rect2(27.8, 12.6, 15.75, 0.26), Rect2(27.8, 15.14, 15.75, 0.26), Rect2(27.8, 12.86, 0.26, 2.28)]
	for r: Rect2 in faces:
		face_box(st, r, 0.45, face, algae)
	for r: Rect2 in walls:
		face_box(st, r, 0.0, face, algae)
	# 4.2 Kerb and hazard paint along the canal, broken at both bridges.
	for run in [Vector2(1390, 1570), Vector2(1700, 1940), Vector2(2070, 2148)]:
		var length: float = (run.y - run.x) / S
		var cx: float = (run.x + run.y) / 2.0 / S
		for z in [12.7, 15.3]:
			add_box(st, Vector3(length, 0.08, 0.2), Vector3(cx, 0.04, z), Basis(), cope)
			var edge: float = z + (0.07 if z < 14.0 else -0.07)
			add_box(st, Vector3(length, 0.012, 0.06), Vector3(cx, 0.086, edge), Basis(), hazard)
	# 3.7 Tide-lock piers standing in the water at the canal mouth.
	for p: Vector2 in GATE_PIERS:
		add_box(st, Vector3(0.64, 5.35, 0.64), m(p, 1.775), Basis(), cope)
	# 4.4 Culvert headwall at the canal head.
	add_box(st, Vector3(0.3, 1.35, 2.6), Vector3(27.99, -0.225, 14.0), Basis(), face)
	finish(st, stone)

func face_box(st: SurfaceTool, r: Rect2, top: float, face: Color, algae: Color) -> void:
	var centre := Vector3(r.position.x + r.size.x / 2, 0, r.position.y + r.size.y / 2)
	var upper := top + 0.25
	add_box(st, Vector3(r.size.x, upper, r.size.y), centre + Vector3(0, top - upper / 2, 0), Basis(), face)
	add_box(st, Vector3(r.size.x, 0.65, r.size.y), centre + Vector3(0, -0.575, 0), Basis(), algae)

# 3.3 Cast-iron bollards: body, yellow band and cap in one mesh, scattered.
func build_bollards() -> void:
	var st := begin()
	var iron := Color("22292c")
	add_cylinder(st, BOLLARD_RADIUS, 0.15, 0.40, Vector3.ZERO, 8, iron)
	add_cylinder(st, 0.15, 0.15, 0.06, Vector3(0, 0.40, 0), 8, Color("dfa949"))
	add_cylinder(st, 0.2, 0.16, 0.06, Vector3(0, 0.46, 0), 8, iron)
	var mesh := st.commit()
	var xforms := []
	for p: Vector2 in BOLLARDS:
		xforms.append(Transform3D(Basis(Vector3.UP, p.x * 0.01), m(p, 0.45)))
	scatter(mesh, xforms, painted)

# 3.4 Galvanised ladders down the seaward face with a grab hoop above the coping.
func build_ladders() -> void:
	var metal := flat(Color("7f8a8c"))
	metal.metallic = 0.5 if not low else 0.0
	for p: Vector2 in LADDERS:
		var north := p.y < 700
		var z := 2.85 - 0.08 if north else 27.95 + 0.08
		var into := 1.0 if north else -1.0
		var parts := []
		for side in [-0.2, 0.2]:
			parts.append([Vector3(0.05, 2.15, 0.05), Vector3(side, 0.175, 0), 0.0])
			# Standoffs tie the rails into the coping.
			parts.append([Vector3(0.04, 0.04, 0.3), Vector3(side, 0.38, into * 0.15), 0.0])
			parts.append([Vector3(0.04, 0.04, 0.12), Vector3(side, -0.5, into * 0.06), 0.0])
		parts.append([Vector3(0.45, 0.05, 0.05), Vector3(0, 1.25, 0), 0.0])
		for k in 3:
			parts.append([Vector3(0.4, 0.035, 0.035), Vector3(0, -0.6 + k * 0.35, 0), 0.0])
		var node := baked(parts, metal, self, near_range())
		node.position = Vector3(p.x / S, 0, z)

# 3.5 / 3.6 Moored tug and fishing boat, bobbing, with lines to the bollards.
func build_boats() -> void:
	var rope := flat(Color("2f2a22"))
	for spec in [["watercraft/boat-tug-a", Vector2(900, 72), 90.0, Vector3(2.5, 3.1, 4.9), [[Vector2(800, 163), Vector2(790, 120)], [Vector2(1040, 163), Vector2(1010, 120)]]],
			["watercraft/boat-fishing-small", Vector2(1880, 1465), -90.0, Vector3(2.3, 3.4, 5.0), [[Vector2(1760, 1377), Vector2(1790, 1425)], [Vector2(1960, 1377), Vector2(1950, 1425)]]]]:
		var holder := view.model(spec[0], spec[3], m(spec[1], -0.95), self)
		holder.rotation.y = deg_to_rad(spec[2])
		cull(holder)
		boats.append({"node": holder, "base": holder.position, "phase": spec[1].x * 0.013})
		var parts := []
		for line in spec[4]:
			var a := m(line[0], 0.9)
			var b := m(line[1], 0.8)
			var mid := (a + b) / 2.0
			var d := b - a
			var basis := Basis.looking_at(d.normalized(), Vector3.UP)
			var st_parts := [Vector3(0.03, 0.03, d.length()), mid, basis]
			parts.append(st_parts)
		var st := begin()
		for part in parts:
			add_box(st, part[0], part[1], part[2], Color.WHITE)
		finish(st, rope, self, near_range())

# 3.7 Gate structure; the leaf is jammed half open until all three pumps run.
func build_gate() -> void:
	var steel := flat(Color("344c55"))
	var beam := view.box(self, Vector3(0.5, 0.55, 3.6), m(Vector2(2163, 700), 4.1), steel)
	var text := Label3D.new()
	text.text = "TIDELOCK 3"
	text.font = preload("res://fonts/FieldSans.ttf")
	text.font_size = 56
	text.pixel_size = 0.006
	text.modulate = Color("e9d9a6")
	text.outline_size = 0
	text.position = Vector3(-0.26, 0, 0)
	text.rotation.y = -PI / 2
	text.visibility_range_end = 40.0
	beam.add_child(text)
	leaf = Node3D.new()
	add_child(leaf)
	leaf.position = m(Vector2(GATE_LEAF_X, 700), 1.8)
	var parts := [[Vector3(0.25, 2.4, 2.8), Vector3.ZERO, 0.0, Color("c99a3f")]]
	for k in 4:
		parts.append([Vector3(0.29, 0.08, 2.8), Vector3(0, -0.9 + k * 0.6, 0), 0.0, Color("5b4a2a")])
	baked(parts, vc_material(0.7), leaf)
	leaf_sound = view.sound3d(preload("res://assets/audio/gate_release.ogg"), leaf, 0.0, 45.0, false)

# 4.3 Chain railings: posts scattered, two chains per run baked.
func build_railings() -> void:
	var post := BoxMesh.new()
	post.size = Vector3(0.06, 1.0, 0.06)
	var metal := flat(Color("7f8a8c"))
	var xforms := []
	for row: float in RAIL_ROWS:
		for run: Vector2 in RAIL_RUNS:
			for x in rail_posts(run):
				xforms.append(Transform3D(Basis(), m(Vector2(x, row), 0.5)))
			var length: float = (run.y - run.x) / S
			var parts := []
			for h in [0.55, 0.95]:
				parts.append([Vector3(length, 0.03, 0.03), m(Vector2((run.x + run.y) / 2.0, row), h), 0.0])
			baked(parts, flat(Color("3a3f40")), self, near_range())
	scatter(post, xforms, metal)

static func rail_posts(run: Vector2) -> Array:
	var count := int(ceil((run.y - run.x) / 100.0))
	var result := []
	for i in count + 1:
		result.append(run.x + (run.y - run.x) * i / count)
	return result

# 4.4 Culvert at the canal head; it gushes once the weir pump (P-02) runs.
func build_culvert() -> void:
	var pipe := CylinderMesh.new()
	pipe.top_radius = 0.7
	pipe.bottom_radius = 0.7
	pipe.height = 1.2
	pipe.radial_segments = 16
	pipe.rings = 1
	pipe.cap_top = false
	pipe.cap_bottom = false
	var tube := MeshInstance3D.new()
	tube.mesh = pipe
	var mat := flat(Color("4a514e"))
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	tube.material_override = mat
	tube.rotation.z = PI / 2
	tube.position = Vector3(28.45, -0.45, 14.0)
	add_child(tube)
	var hole := CylinderMesh.new()
	hole.top_radius = 0.66
	hole.bottom_radius = 0.66
	hole.height = 0.02
	hole.radial_segments = 16
	var dark := MeshInstance3D.new()
	dark.mesh = hole
	dark.material_override = flat(Color("0c1214"))
	dark.rotation.z = PI / 2
	dark.position = Vector3(28.2, -0.45, 14.0)
	add_child(dark)
	var foam_mat := StandardMaterial3D.new()
	foam_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	foam_mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	foam_mat.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	foam_mat.disable_fog = true
	foam_mat.albedo_texture = radial()
	foam_mat.albedo_color = Color(0.32, 0.36, 0.36)
	var foam := PlaneMesh.new()
	foam.size = Vector2(1.5, 1.0)
	culvert_foam = MeshInstance3D.new()
	culvert_foam.mesh = foam
	culvert_foam.material_override = foam_mat
	culvert_foam.position = Vector3(29.65, -0.33, 14.0)
	culvert_foam.visible = false
	add_child(culvert_foam)
	if not low:
		var drop := QuadMesh.new()
		drop.size = Vector2(0.12, 0.12)
		var spray := StandardMaterial3D.new()
		spray.albedo_color = Color(0.78, 0.86, 0.88, 0.5)
		spray.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		spray.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		spray.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
		drop.material = spray
		culvert_flow = CPUParticles3D.new()
		culvert_flow.position = Vector3(29.0, -0.15, 14.0)
		culvert_flow.emitting = false
		culvert_flow.amount = 40
		culvert_flow.lifetime = 0.6
		culvert_flow.emission_shape = CPUParticles3D.EMISSION_SHAPE_BOX
		culvert_flow.emission_box_extents = Vector3(0.02, 0.12, 0.35)
		culvert_flow.direction = Vector3(1, -0.1, 0)
		culvert_flow.spread = 10
		culvert_flow.initial_velocity_min = 1.6
		culvert_flow.initial_velocity_max = 2.3
		culvert_flow.gravity = Vector3(0, -9.8, 0)
		culvert_flow.mesh = drop
		add_child(culvert_flow)
	culvert_sound = view.sound3d(preload("res://assets/audio/outflow_loop.ogg"), culvert_foam, -12.0, 16.0, false)

func radial() -> GradientTexture2D:
	var tex := GradientTexture2D.new()
	tex.fill = GradientTexture2D.FILL_RADIAL
	tex.fill_from = Vector2(0.5, 0.5)
	tex.fill_to = Vector2(1.0, 0.5)
	tex.width = 64
	tex.height = 64
	var ramp := Gradient.new()
	ramp.offsets = PackedFloat32Array([0.0, 0.5, 1.0])
	ramp.colors = PackedColorArray([Color(1, 1, 1, 1), Color(1, 1, 1, 0.35), Color(1, 1, 1, 0)])
	tex.gradient = ramp
	return tex

# 4.5 Floating debris drifting toward the canal mouth (motion A1).
func build_debris() -> void:
	var plank := BoxMesh.new()
	plank.size = Vector3(1.8, 0.05, 0.22)
	var wood := flat(Color("5a4a3a"))
	var items := [
		["old_tyre", 1430, 13.2, Vector3(PI / 2, 0, 0)], ["plank", 1510, 14.7, Vector3.ZERO],
		["barrel_01", 1640, 14.0, Vector3(0, 0, PI / 2)], ["plastic_crate_03", 1730, 13.7, Vector3.ZERO],
		["plank", 1800, 13.3, Vector3.ZERO], ["trashbag", 1880, 14.3, Vector3.ZERO],
		["old_tyre", 2000, 14.8, Vector3(PI / 2, 0, 0)], ["plank", 2080, 13.8, Vector3.ZERO],
		["plank", 2130, 14.2, Vector3.ZERO],
	]
	for i in items.size():
		var item: Array = items[i]
		var root: Node3D
		if item[0] == "plank":
			root = Node3D.new()
			add_child(root)
			var board := MeshInstance3D.new()
			board.mesh = plank
			board.material_override = wood
			board.position.y = 0.025
			board.visibility_range_end = near_range()
			root.add_child(board)
			root.set_meta("height", 0.05)
		else:
			root = tilted(item[0], self, Vector3.ZERO, 0.0, item[3])
		var height: float = root.get_meta("height")
		var freeboard := minf(0.12, height * 0.35)
		floaters.append({"node": root, "x": float(item[1]) / S, "z": item[2], "phase": i * 1.7,
			"speed": 0.85 + 0.3 * fmod(i * 0.37, 1.0), "draft": height - freeboard, "height": height,
			"yaw": i * 0.9, "plank": item[0] == "plank"})

# 6.1, 6.2, 6.7 Kenney vehicles and the cargo pile on their solid footprints.
func build_set_pieces() -> void:
	for piece in HarborData.SET_PIECES:
		var holder := view.model(piece[0], piece[3], m(piece[1]), self)
		holder.rotation.y = deg_to_rad(piece[2])
		cull(holder)
		var shadow := MeshInstance3D.new()
		var plane := PlaneMesh.new()
		var fp: Vector2 = piece[4]
		plane.size = fp / S + Vector2(0.5, 0.5)
		shadow.mesh = plane
		var shade := ShaderMaterial.new()
		shade.shader = preload("res://shaders/contact_shadow.gdshader")
		shadow.material_override = shade
		shadow.position = m(piece[1], 0.01)
		shadow.visibility_range_end = near_range()
		add_child(shadow)

# 6.4 / 6.5 Sandbag walls at the Borough Power door and the B4 east face.
func build_sandbags() -> void:
	var bag: Array = glb_mesh("res://assets/props/cement_bag.glb")
	var xforms := []
	var specs := [
		[954, 1131.5, 0, 95], [985, 1131.5, 0, 86], [1016, 1131.5, 0, 92],
		[969, 1131.5, 1, 88], [1000, 1131.5, 1, 94], [985, 1131.5, 2, 91],
		[451.5, 707, 0, 4], [451.5, 743, 0, -5], [451.5, 725, 1, 2],
	]
	for s in specs:
		xforms.append(Transform3D(Basis(Vector3.UP, deg_to_rad(s[3])), m(Vector2(s[0], s[1]), s[2] * 0.16)))
	scatter(bag[0], xforms, bag[1])

# 6.6 Pallet stack on the north apron; the crates on and beside it are PROPS.
func build_pallets() -> void:
	var parts := []
	for level in 5:
		var yaw := deg_to_rad([0.0, 3.0, -2.0, 4.0, -1.0][level])
		var base := m(Vector2(947, 198), level * 0.144)
		var basis := Basis(Vector3.UP, yaw)
		var tone := Color("6e5a42").lerp(Color("7d6a50"), fmod(level * 0.43, 1.0))
		for z in [-0.35, 0.0, 0.35]:
			parts.append([Vector3(1.2, 0.12, 0.1), base + basis * Vector3(0, 0.06, z), yaw, tone])
		for x in [-0.53, -0.265, 0.0, 0.265, 0.53]:
			parts.append([Vector3(0.14, 0.024, 0.8), base + basis * Vector3(x, 0.132, 0), yaw, tone])
	baked(parts, vc_material(0.85), self, near_range())

# 6.8 Jib crane in the NE weir yard with a swinging hook (A11).
func build_crane() -> void:
	var st := begin()
	var steel := Color("344c55")
	var yellow := Color("dfa949")
	var base := m(JIB_CRANE)
	add_box(st, Vector3(1.0, 0.25, 1.0), base + Vector3(0, 0.125, 0), Basis(), Color("7d837e"))
	add_cylinder(st, 0.45, 0.4, 5.0, base, 12, steel)
	var heading := Vector3(-sin(deg_to_rad(15.0)), 0, -cos(deg_to_rad(15.0)))
	var yaw_basis := Basis.looking_at(heading, Vector3.UP)
	add_box(st, Vector3(1.4, 1.2, 1.8), base + Vector3(0, 5.6, 0), yaw_basis, steel)
	add_box(st, Vector3(1.0, 0.9, 0.7), base + Vector3(0, 5.55, 0) - heading * 1.2, yaw_basis, Color("2a3236"))
	var pivot := base + Vector3(0, 6.0, 0)
	var jib := (heading * cos(deg_to_rad(22.0)) + Vector3(0, sin(deg_to_rad(22.0)), 0)).normalized()
	add_box(st, Vector3(0.35, 0.35, 10.0), pivot + jib * 5.0, Basis.looking_at(jib, Vector3.UP), yellow)
	# A tie from the house roof to the jib's mid point.
	var tie_from := base + Vector3(0, 6.3, 0) - heading * 0.5
	var tie_to := pivot + jib * 6.0
	add_box(st, Vector3(0.08, 0.08, tie_from.distance_to(tie_to)), (tie_from + tie_to) / 2.0, Basis.looking_at((tie_to - tie_from).normalized(), Vector3.UP), steel)
	finish(st, vc_material(0.7))
	var tip := pivot + jib * 10.0
	hook_pivot = Node3D.new()
	add_child(hook_pivot)
	hook_pivot.position = tip
	var drop := tip.y - 1.0
	var hook := begin()
	add_box(hook, Vector3(0.04, drop, 0.04), Vector3(0, -drop / 2.0, 0), Basis(), Color("1f2426"))
	add_box(hook, Vector3(0.3, 0.3, 0.3), Vector3(0, -drop, 0), Basis(), yellow)
	finish(hook, vc_material(0.6), hook_pivot, near_range())

# 5.4 Storm wrack along the seawall feet: one baked mesh of noise-cut decals.
func build_wrack() -> void:
	var st := begin()
	for i in WRACK.size():
		var p: Vector2 = WRACK[i]
		var yaw := sin(i * 2.3) * 0.18
		var basis := Basis(Vector3.UP, yaw)
		var c := m(p, 0.008)
		var corners := [Vector3(-0.8, 0, -0.3), Vector3(0.8, 0, -0.3), Vector3(0.8, 0, 0.3), Vector3(-0.8, 0, 0.3)]
		var uvs := [Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)]
		for tri_index in [[0, 1, 2], [0, 2, 3]]:
			var pts := []
			for k in tri_index:
				pts.append(k)
			# Wound so the top faces up: (b - a) x (c - a) must point down.
			var a: Vector3 = c + basis * corners[pts[0]]
			var b: Vector3 = c + basis * corners[pts[1]]
			var d: Vector3 = c + basis * corners[pts[2]]
			var order := pts if (b - a).cross(d - a).y < 0.0 else [pts[0], pts[2], pts[1]]
			for k in order:
				st.set_normal(Vector3.UP)
				st.set_uv(uvs[k])
				st.add_vertex(c + basis * corners[k])
	var shader := Shader.new()
	shader.code = """
shader_type spatial;
render_mode cull_disabled;
varying vec3 wp;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x),f.y);}
void vertex(){wp=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;}
void fragment(){
 vec2 q=UV*2.0-1.0;
 float shape=1.0-dot(q,q);
 float n=noise(wp.xz*6.0)*0.65+noise(wp.xz*19.0)*0.35;
 if(shape*1.3+n*0.9<0.95) discard;
 ALBEDO=mix(vec3(0.011,0.023,0.014),vec3(0.028,0.042,0.022),noise(wp.xz*13.0));
 ROUGHNESS=0.45;
}
"""
	var mat := ShaderMaterial.new()
	mat.shader = shader
	var node := finish(st, mat)
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF

# 5.5 Flat litter: planks scattered on the paving and two tyres lying flat.
func build_litter() -> void:
	var plank := BoxMesh.new()
	plank.size = Vector3(1.8, 0.05, 0.22)
	var xforms := []
	for item in LITTER_PLANKS:
		xforms.append(Transform3D(Basis(Vector3.UP, deg_to_rad(item[1])), m(item[0], 0.025)))
	scatter(plank, xforms, flat(Color("5a4a3a")))
	for p in [Vector2(300, 880), Vector2(1500, 1300)]:
		tilted("old_tyre", self, m(p), p.x * 0.01, Vector3(PI / 2, 0, 0))

# 5.6 Poly Haven street lamps; the existing OmniLights move to the lantern (high only).
func build_lamps() -> void:
	var bulb := flat(Color("ffcb88"), 2.0)
	for lamp in LAMPS:
		var head: Vector2 = lamp[0] + lamp[1] * LAMP_REACH
		var dir: Vector2 = lamp[1]
		var post := view.prop_local("street_lamp_01", view, m(head), 0.0 if absf(dir.x) > 0.5 else 90.0)
		var core := view.box(post, Vector3(0.1, 0.16, 0.1), Vector3(0, 3.33, 0), bulb)
		core.visibility_range_end = near_range()
		if low:
			continue
		var light := OmniLight3D.new()
		light.position = m(head, 3.3)
		light.light_color = Color("ffd398")
		light.light_energy = 1.4
		light.omni_range = 5
		view.add_child(light)

# ---------------------------------------------------------------- motion

func tick(delta: float, elapsed: float) -> void:
	ticks += 1
	var still := view.reduced_motion
	wind = 0.6 + 0.4 * sin(elapsed * 0.21) * sin(elapsed * 0.057 + 1.3)
	var restored: int = view.campaign.pumps.count(true)
	# 3.7 The tide-lock leaf drops over 4 s once every pump runs.
	var want_down := restored >= 3
	# Only a repair made in play animates; a loaded checkpoint jumps straight to its state.
	var repaired_now := prev_restored == 2 and not prev_menu
	prev_restored = restored
	prev_menu = view.menu
	if want_down != gate_down:
		gate_down = want_down
		if want_down and repaired_now:
			if view.sound_enabled and DisplayServer.get_name() != "headless":
				leaf_sound.play()
		else:
			gate_drop = 1.0 if want_down else 0.0
	gate_drop = move_toward(gate_drop, 1.0 if gate_down else 0.0, delta / 4.0)
	leaf.position.y = lerpf(1.8, -0.6, smoothstep(0.0, 1.0, gate_drop))
	# 4.4 The weir pump drives the culvert.
	var flowing: bool = view.campaign.pumps[1]
	if flowing != culvert_on:
		culvert_on = flowing
		culvert_foam.visible = flowing
		if flowing and DisplayServer.get_name() != "headless":
			culvert_sound.stream.loop = true
			culvert_sound.play()
		elif not flowing:
			culvert_sound.stop()
	if culvert_flow:
		culvert_flow.emitting = culvert_on and not still
	# A1 Debris drifts seaward, faster as pumps return, almost still behind the closed gate.
	var current := 0.03 if gate_drop > 0.99 else 0.12 + 0.06 * restored
	for f in floaters:
		f.x += current * f.speed * delta
		if f.x > DRIFT_END:
			f.x = DRIFT_START
		var at := Vector3(f.x, 0, f.z)
		var sink := 0.0
		for span: Vector2 in CANAL_BRIDGE_SPANS:
			if f.x > span.x - 0.4 and f.x < span.y + 0.4:
				sink = 0.18
		# Slip under the surface at both ends so the wrap is never seen.
		var fade := clampf(minf(f.x - DRIFT_START, DRIFT_END - f.x) / 0.8, 0.0, 1.0)
		sink += (1.0 - fade) * (f.height + 0.1)
		var node: Node3D = f.node
		node.position = Vector3(f.x, water_y(at) - f.draft - sink, f.z)
		node.rotation.x = sin(elapsed * 1.1 + f.phase) * 0.08
		node.rotation.z = sin(elapsed * 0.9 + f.phase * 1.3) * 0.08
		if f.plank:
			node.rotation.y = f.yaw * 0.1 + sin(elapsed * 0.3 + f.phase) * 0.22
		else:
			f.yaw += 0.05 * delta
			node.rotation.y = f.yaw
	# A2 Moored boats ride the swell.
	for b in boats:
		var node: Node3D = b.node
		node.position.y = b.base.y + (water_y(b.base) + 0.42)
		node.rotation.z = sin(elapsed * 0.7 + b.phase) * 0.03 * (1.0 + wind)
		node.rotation.x = sin(elapsed * 0.9 + b.phase) * 0.02
	# A11 Crane hook pendulum.
	if still:
		hook_pivot.rotation = Vector3.ZERO
	else:
		hook_pivot.rotation.z = sin(elapsed * 1.1) * 0.06 * wind
		hook_pivot.rotation.x = sin(elapsed * 0.8) * 0.04 * wind

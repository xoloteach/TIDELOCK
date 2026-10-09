class_name FirstPersonView
extends Node3D

# Campaign coordinates use 50 units per metre. Rendering and collision share HarborData.
const SCALE := 50.0
var campaign: Campaign
var menu := true
var reduced_motion := false
var damage_flash := 0.0
var camera := Vector2.ZERO
var yaw := 0.0
var pitch := 0.0
var moving := false
var flashlight_enabled := true
var eyes: Camera3D
var torch: SpotLight3D
var tool: Node3D
var pumps: Array[Node3D] = []
var supplies: Array[Node3D] = []
var records: Array[Node3D] = []
var patrols: Array[Node3D] = []
var gate: MeshInstance3D
var pulse: MeshInstance3D
var rain: CPUParticles3D
var sparks: CPUParticles3D
var elapsed := 0.0
var amber_material: StandardMaterial3D
var green_material: StandardMaterial3D
var jump_height := 0.0
var jump_speed := 0.0
var foot_clock := 0.0
signal footstep

func world(p: Vector2, height: float = 0.0) -> Vector3:
	return Vector3(p.x / SCALE, height, p.y / SCALE)

func material(color: Color, glow: float = 0.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.roughness = 0.72
	m.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
	if glow > 0:
		m.emission_enabled = true
		m.emission = color
		m.emission_energy_multiplier = glow
	return m

func box(parent: Node3D, size: Vector3, at: Vector3, mat: Material) -> MeshInstance3D:
	var mesh := BoxMesh.new()
	mesh.size = size
	var node := MeshInstance3D.new()
	node.mesh = mesh
	node.material_override = mat
	node.position = at
	parent.add_child(node)
	return node

func bounds_of(root: Node3D) -> AABB:
	var result := AABB()
	var found := false
	for child in root.find_children("*", "MeshInstance3D", true, false):
		var relative: Transform3D = root.global_transform.affine_inverse() * child.global_transform
		var b: AABB = relative * child.get_aabb()
		result = result.merge(b) if found else b
		found = true
	return result

func model(path: String, size: Vector3, at: Vector3, parent: Node3D = self) -> Node3D:
	var holder := Node3D.new()
	parent.add_child(holder)
	var scene: PackedScene = load("res://assets/" + path + ".glb")
	var instance: Node3D = scene.instantiate()
	holder.add_child(instance)
	var b := bounds_of(instance)
	instance.scale = size / b.size
	instance.position = Vector3(-b.get_center().x, -b.position.y, -b.get_center().z) * instance.scale
	if OS.has_feature("web"):
		for mesh in instance.find_children("*", "MeshInstance3D", true, false):
			for surface in range(mesh.mesh.get_surface_count()):
				var mat: Material = mesh.get_active_material(surface)
				if mat is StandardMaterial3D:
					mat.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
	holder.position = at
	return holder

func label(parent: Node3D, value: String, at: Vector3, color: Color = Color("e4eada"), size: int = 40) -> Label3D:
	var node := Label3D.new()
	node.text = value
	node.font = preload("res://fonts/FieldSans.ttf")
	node.font_size = size
	node.pixel_size = 0.008
	node.modulate = color
	node.outline_size = 3
	node.visibility_range_end = 12.0
	node.position = at
	node.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	node.no_depth_test = false
	parent.add_child(node)
	return node

func _ready() -> void:
	# Software WebGL and phones use a smaller 3D buffer; the HUD remains full resolution.
	var adapter := RenderingServer.get_video_adapter_name().to_lower()
	var software := "swiftshader" in adapter or "llvmpipe" in adapter
	if OS.has_feature("web"):
		software = software or bool(JavaScriptBridge.eval("new URLSearchParams(location.search).get('quality') === 'low'"))
	get_viewport().scaling_3d_scale = 0.5 if software else 0.85
	var env := WorldEnvironment.new()
	var settings := Environment.new()
	settings.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	var sky_mat := ProceduralSkyMaterial.new()
	sky_mat.sky_top_color = Color("192c43")
	sky_mat.sky_horizon_color = Color("607e88")
	sky_mat.ground_bottom_color = Color("17252c")
	sky_mat.ground_horizon_color = Color("607e88")
	sky.sky_material = sky_mat
	settings.sky = sky
	settings.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	settings.ambient_light_color = Color("9ab9c5")
	settings.ambient_light_energy = 0.65
	settings.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	settings.fog_enabled = true
	settings.fog_light_color = Color("506975")
	settings.fog_density = 0.016
	env.environment = settings
	add_child(env)
	var sun := DirectionalLight3D.new()
	sun.light_color = Color("bed5e0")
	sun.light_energy = 1.15
	sun.rotation_degrees = Vector3(-42, -32, 0)
	sun.shadow_enabled = not software and not OS.has_feature("web")
	sun.directional_shadow_max_distance = 55
	add_child(sun)
	var concrete := material(Color("929d97"))
	concrete.albedo_texture = preload("res://assets/concrete/Color.jpg")
	concrete.normal_enabled = true
	concrete.normal_texture = preload("res://assets/concrete/NormalGL.jpg")
	concrete.roughness_texture = preload("res://assets/concrete/Roughness.jpg")
	concrete.uv1_scale = Vector3(18, 12, 1)
	amber_material = material(Color("dda94c"),1)
	green_material = material(Color("77dbc1"),1)
	var steel := material(Color("344c55"))
	var yellow := material(Color("dfa949"))
	# Four slabs leave the canal open; the only crossings are the two marked bridges.
	for r in [Rect2(140,160,2020,470), Rect2(140,770,2020,610), Rect2(140,630,1250,140)]:
		box(self, Vector3(r.size.x/SCALE,0.35,r.size.y/SCALE),world(r.get_center(),-0.175),concrete)
	for r in HarborData.BRIDGES:
		box(self,Vector3(r.size.x/SCALE,0.25,r.size.y/SCALE),world(r.get_center(),-0.10),steel)
		for side in [-1,1]:
			box(self,Vector3(0.06,0.08,2.8),world(r.get_center(),0.9)+Vector3(side*1.01,0,0),yellow)
			for offset in [-1.2,0,1.2]:
				box(self,Vector3(0.06,0.9,0.06),world(r.get_center(),0.45)+Vector3(side*1.01,0,offset),steel)
	var ocean := PlaneMesh.new()
	ocean.size = Vector2(130,110)
	var sea := MeshInstance3D.new()
	sea.mesh = ocean
	sea.position = Vector3(25,-0.42,18)
	var water := ShaderMaterial.new()
	water.shader = preload("res://shaders/water.gdshader")
	sea.material_override = water
	add_child(sea)
	# Actual library models, fitted to the exact solid collision footprints.
	var names := ["building-a","building-c","building-f","building-i","building-l","building-o","building-r","building-t"]
	for i in range(HarborData.BUILDINGS.size()):
		var r: Rect2 = HarborData.BUILDINGS[i]
		box(self,Vector3(r.size.x/SCALE,0.08,r.size.y/SCALE),world(r.get_center(),0.04),steel)
		model("industrial/"+names[i],Vector3(r.size.x/SCALE,3.4 if i<3 else 2.4,r.size.y/SCALE),world(r.get_center()))
		if i<3:
			label(self,["MORROW QUAY / DEPOT","BOROUGH POWER","NORTH WEIR WORKS"][i],world(r.get_center(),4.3),Color("d8dfcd"),32)
	# Quay edge walls match the world bounds and make inaccessible ocean readable.
	for r in [Rect2(140,160,2020,10),Rect2(140,1370,2020,10),Rect2(140,160,10,1220),Rect2(2150,160,10,1220)]:
		box(self,Vector3(r.size.x/SCALE,0.6,r.size.y/SCALE),world(r.get_center(),0.3),steel)
	for p in [Vector2(190,280),Vector2(2050,280),Vector2(190,1270),Vector2(2080,910)]:
		model("survival/barrel",Vector3(0.6,0.9,0.6),world(p))
	# Background silhouettes are beyond the playable seawall.
	for i in range(7):
		model("industrial/shipping-container-a",Vector3(3.2,1.7,1.5),Vector3(8+i*4.8,0,1.2))
	model("industrial/water-tower",Vector3(2.5,8,2.5),Vector3(2,0,5))
	model("industrial/chimney-large",Vector3(1.8,9,1.8),Vector3(43,0,3))
	for i in range(3):
		var pump := Node3D.new()
		add_child(pump)
		pump.position = world(HarborData.PUMPS[i])
		model("industrial/detail-tank",Vector3(0.8,1.2,0.9),Vector3(0,0,-0.05),pump)
		box(pump,Vector3(0.85,0.7,0.14),Vector3(0,0.95,0.53),steel)
		box(pump,Vector3(0.58,0.21,0.04),Vector3(0,1.09,0.62),material(Color("dda94c"),1))
		for j in range(3):
			var wheel := TorusMesh.new()
			wheel.inner_radius=0.065
			wheel.outer_radius=0.095
			var rotor := MeshInstance3D.new()
			rotor.mesh=wheel
			rotor.rotation.x=PI/2
			rotor.position=Vector3(-0.25+j*0.25,0.83,0.62)
			rotor.material_override=yellow
			pump.add_child(rotor)
		label(pump,HarborData.PUMP_NAMES[i],Vector3(0,2.3,0),Color("f2c36c"),34)
		pumps.append(pump)
		var supply := model("survival/box",Vector3(0.6,0.5,0.5),world(HarborData.FUSES[i]))
		box(supply,Vector3(0.52,0.04,0.36),Vector3(0,0.52,0),material(Color("ffc46e"),1.5))
		label(supply,"FUSE",Vector3(0,1.3,0),Color("ffc46e"),30)
		supplies.append(supply)
		var record := Node3D.new()
		add_child(record)
		record.position=world(HarborData.LOGS[i])
		box(record,Vector3(0.07,1,0.07),Vector3(0,0.5,0),steel)
		box(record,Vector3(0.38,0.25,0.06),Vector3(0,1.1,0),material(Color("b3d2c9"),0.4))
		label(record,"SHIFT LOG",Vector3(0,1.7,0),Color("c7ded6"),26)
		records.append(record)
	# Autonomous maintenance machines built from tank/steel parts, with search lights.
	for i in range(4):
		var patrol := Node3D.new()
		add_child(patrol)
		model("industrial/detail-tank-large",Vector3(0.65,0.65,0.75),Vector3(0,0.32,0),patrol)
		for x in [-0.35,0.35]:
			for z in [-0.24,0.24]:
				box(patrol,Vector3(0.15,0.35,0.26),Vector3(x,0.18,z),steel)
		box(patrol,Vector3(0.48,0.09,0.1),Vector3(0,0.72,-0.4),material(Color("ff754c"),2))
		var lamp := SpotLight3D.new()
		lamp.position=Vector3(0,0.73,-0.44)
		lamp.rotation.x=-0.20
		lamp.light_color=Color("ff9c62")
		lamp.light_energy=3
		lamp.spot_range=5
		lamp.spot_angle=42
		patrol.add_child(lamp)
		patrols.append(patrol)
	gate=box(self,Vector3(0.28,2.1,5.4),world(Vector2(2034,1225),1.05),yellow)
	label(self,"EAST EVAC / RESTORE 3 PUMPS",world(HarborData.EXIT,3),Color("7cd6c6"),36)
	box(self,Vector3(0.6,0.12,0.6),world(HarborData.EXIT,0.06),material(Color("79debc"),2))
	for p in [Vector2(240,950),Vector2(610,810),Vector2(1300,570),Vector2(1700,820),Vector2(2110,1050)]:
		box(self,Vector3(0.06,3.4,0.06),world(p,1.7),steel)
		box(self,Vector3(0.4,0.1,0.25),world(p,3.4),material(Color("ffcb88"),2))
		var lamp := OmniLight3D.new()
		lamp.position=world(p,3.15)
		lamp.light_color=Color("ffd398")
		lamp.light_energy=1.4
		lamp.omni_range=5
		add_child(lamp)
	eyes=Camera3D.new()
	eyes.fov=78
	eyes.near=0.06
	eyes.far=180
	eyes.current=true
	add_child(eyes)
	torch=SpotLight3D.new()
	torch.position=Vector3(0.18,-0.12,-0.12)
	torch.light_color=Color("e3f3df")
	torch.light_energy=2.4
	torch.spot_range=13
	torch.spot_angle=34
	torch.shadow_enabled=not software and not OS.has_feature("web")
	eyes.add_child(torch)
	tool=model("survival/tool-hammer",Vector3(0.18,0.34,0.08),Vector3(0.32,-0.35,-0.67),eyes)
	tool.rotation_degrees=Vector3(12,0,-18)
	var ring := TorusMesh.new()
	ring.inner_radius=0.94
	ring.outer_radius=1.0
	pulse=MeshInstance3D.new()
	pulse.mesh=ring
	pulse.material_override=material(Color("76e9cd"),3)
	add_child(pulse)
	rain=CPUParticles3D.new()
	rain.amount=180 if software else 400
	rain.lifetime=0.9
	rain.emission_shape=CPUParticles3D.EMISSION_SHAPE_BOX
	rain.emission_box_extents=Vector3(9,0.5,9)
	rain.direction=Vector3(-0.08,-1,0.03)
	rain.spread=4
	rain.initial_velocity_min=12
	rain.initial_velocity_max=16
	rain.gravity=Vector3(0,-1,0)
	var drop := BoxMesh.new()
	drop.size=Vector3(0.008,0.28,0.008)
	drop.material=material(Color("9db9c5"))
	rain.mesh=drop
	add_child(rain)
	sparks = CPUParticles3D.new()
	sparks.emitting = false
	sparks.one_shot = true
	sparks.amount = 28
	sparks.lifetime = 0.65
	sparks.explosiveness = 1.0
	sparks.direction = Vector3(0,1,0)
	sparks.spread = 110
	sparks.initial_velocity_min = 1.5
	sparks.initial_velocity_max = 3.5
	sparks.gravity = Vector3(0,-4,0)
	var sprite := QuadMesh.new()
	sprite.size = Vector2(0.15,0.15)
	var spark_material := StandardMaterial3D.new()
	spark_material.albedo_texture = preload("res://assets/particles/spark_06.png")
	spark_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	spark_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	spark_material.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	spark_material.vertex_color_use_as_albedo = true
	sprite.material = spark_material
	sparks.mesh = sprite
	add_child(sparks)

func burst(at: Vector2, repair: bool = false) -> void:
	sparks.position = world(at,1.1)
	sparks.color = Color("ffd79b") if repair else Color("7ef5d4")
	sparks.restart()
	sparks.emitting = true

func look(relative: Vector2) -> void:
	yaw -= relative.x * 0.0025
	pitch = clampf(pitch-relative.y*0.0025,-1.25,1.25)

func jump() -> void:
	if jump_height<=0:
		jump_speed=3.2

func _process(delta: float) -> void:
	elapsed+=delta
	if elapsed > 6 and Engine.get_frames_per_second() < 25 and get_viewport().scaling_3d_scale > 0.6:
		get_viewport().scaling_3d_scale = 0.6
	damage_flash=maxf(0,damage_flash-delta)
	if menu:
		eyes.position=Vector3(11+sin(elapsed*0.06)*3,7.0,29)
		eyes.look_at(Vector3(23,0,13))
		tool.visible=false
	else:
		jump_speed-=delta*9.8
		jump_height=maxf(0,jump_height+jump_speed*delta)
		if jump_height<=0:jump_speed=0
		var bob := sin(elapsed*10)*0.035 if moving and not reduced_motion else 0.0
		eyes.position=world(campaign.position,1.65+jump_height+bob)
		eyes.rotation=Vector3(pitch,yaw,0)
		tool.visible=true
		tool.position.y=-0.35+bob
		if moving:
			foot_clock+=delta
			if foot_clock>0.42:
				foot_clock=0
				footstep.emit()
		else:foot_clock=0.3
	torch.visible=flashlight_enabled and not menu
	rain.position=eyes.position+Vector3(0,6,0)
	rain.emitting=not reduced_motion
	for i in range(3):
		supplies[i].visible=not campaign.collected[i]
		records[i].visible=not campaign.logs[i]
		var indicator: MeshInstance3D=pumps[i].get_child(2)
		indicator.material_override=green_material if campaign.pumps[i] else amber_material
	for i in range(4):
		var drone: Dictionary=campaign.drones[i]
		patrols[i].position=world(drone.position)
		var h: Vector2=drone.heading
		patrols[i].rotation.y=atan2(-h.x,-h.y)
		patrols[i].get_child(patrols[i].get_child_count()-1).visible=drone.stun<=0
	gate.visible=campaign.pumps.count(true)<3
	pulse.visible=campaign.pulse_ring>0
	if pulse.visible:
		pulse.position=world(campaign.position,0.05)
		pulse.scale=Vector3.ONE*maxf(0.1,(1-campaign.pulse_ring)*5.4)

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
var sound_enabled := true
var sky_material: ShaderMaterial
var sun: DirectionalLight3D
var environment: Environment
var flash := 0.0
var sky_flash := 0.0
var next_strike := 7.0
var thunder_delay := -1.0
var thunder_strength := 0.0
var npcs: Array[Dictionary] = []
var focus_npc := -1
var outflows: Array[CPUParticles3D] = []
var pump_sounds: Array[AudioStreamPlayer3D] = []
var patrol_alarms: Array[AudioStreamPlayer3D] = []
var patrol_alert: Array[float] = [0.0, 0.0, 0.0, 0.0]
var sounds3d: Array[AudioStreamPlayer3D] = []
var waves: Array[Dictionary] = []
var splashes: CPUParticles3D
# Software WebGL (and ?quality=low) draws less: shorter view ranges, no cosmetic particles.
var low_quality := false
signal footstep
signal thunder(strength: float)

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
					if path.begins_with("industrial/building"):
						var weathered := ShaderMaterial.new()
						weathered.shader = preload("res://shaders/weathered_metal.gdshader")
						weathered.set_shader_parameter("palette",mat.albedo_texture)
						weathered.set_shader_parameter("weathering",preload("res://assets/concrete/Color.jpg"))
						mesh.set_surface_override_material(surface,weathered)
					else:
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
	low_quality = software
	var env := WorldEnvironment.new()
	var settings := Environment.new()
	settings.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	var sky_mat := ShaderMaterial.new()
	sky_mat.shader = preload("res://shaders/storm_sky.gdshader")
	sky_mat.set_shader_parameter("clouds", preload("res://assets/sky/storm_clouds.jpg"))
	sky.sky_material = sky_mat
	sky.radiance_size = Sky.RADIANCE_SIZE_64
	sky.process_mode = Sky.PROCESS_MODE_INCREMENTAL
	sky_material = sky_mat
	settings.sky = sky
	settings.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	settings.ambient_light_color = Color("9ab9c5")
	settings.ambient_light_energy = 0.60
	settings.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	settings.fog_enabled = true
	settings.fog_light_color = Color("58676d")
	settings.fog_density = 0.010
	env.environment = settings
	environment = settings
	add_child(env)
	sun = DirectionalLight3D.new()
	sun.light_color = Color("ded9c6")
	sun.light_energy = 0.95
	sun.rotation_degrees = Vector3(-42, -32, 0)
	sun.shadow_enabled = not software and not OS.has_feature("web")
	sun.directional_shadow_max_distance = 55
	add_child(sun)
	var concrete := ShaderMaterial.new()
	concrete.shader = preload("res://shaders/wet_quay.gdshader")
	concrete.set_shader_parameter("concrete_color",preload("res://assets/concrete/Color.jpg"))
	concrete.set_shader_parameter("concrete_normal",preload("res://assets/concrete/NormalGL.jpg"))
	concrete.set_shader_parameter("concrete_roughness",preload("res://assets/concrete/Roughness.jpg"))
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
	ocean.subdivide_width = 48
	ocean.subdivide_depth = 40
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
		var shadow := MeshInstance3D.new()
		var shadow_plane := PlaneMesh.new()
		shadow_plane.size = r.size/SCALE+Vector2(1.3,1.3)
		shadow.mesh = shadow_plane
		var shadow_mat := ShaderMaterial.new()
		shadow_mat.shader = preload("res://shaders/contact_shadow.gdshader")
		shadow.material_override = shadow_mat
		shadow.position = world(r.get_center(),0.006)
		add_child(shadow)
		box(self,Vector3(r.size.x/SCALE,0.08,r.size.y/SCALE),world(r.get_center(),0.04),steel)
		model("industrial/"+names[i],Vector3(r.size.x/SCALE,4.3 if i<3 else 3.0,r.size.y/SCALE),world(r.get_center()))
		if i<3:
			label(self,["MORROW QUAY / DEPOT","BOROUGH POWER","NORTH WEIR WORKS"][i],world(r.get_center(),5.0),Color("d8dfcd"),32)
	# Worn loading-lane paint and flush drains give the paved dock a human scale.
	var paint := material(Color("a59b72"))
	for x in range(270,1970,100):
		box(self,Vector3(1.0,0.005,0.065),world(Vector2(x,1270),0.005),paint)
	for p in [Vector2(490,1130),Vector2(760,900),Vector2(1330,590),Vector2(1860,1250)]:
		box(self,Vector3(0.65,0.006,0.4),world(p,0.007),material(Color("14252b")))
		for slot in range(6):
			box(self,Vector3(0.025,0.01,0.38),world(p,0.012)+Vector3(-0.27+slot*0.105,0,0),steel)
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
		# Contractor crate (Poly Haven) with a lit amber fuse tag on its lid.
		var supply := Node3D.new()
		add_child(supply)
		supply.position = world(HarborData.FUSES[i])
		supply.rotation.y = [0.4, -0.7, 1.9][i]
		var crate := prop_local("old_military_crate", supply, Vector3.ZERO, 0.0)
		crate.scale = Vector3.ONE * 0.7
		box(supply,Vector3(0.34,0.03,0.16),Vector3(0,0.23,0),material(Color("ffc46e"),1.5))
		label(supply,"FUSE",Vector3(0,1.1,0),Color("ffc46e"),30)
		supplies.append(supply)
		var record := Node3D.new()
		add_child(record)
		record.position=world(HarborData.LOGS[i])
		box(record,Vector3(0.07,1,0.07),Vector3(0,0.5,0),steel)
		box(record,Vector3(0.38,0.25,0.06),Vector3(0,1.1,0),material(Color("b3d2c9"),0.4))
		var sheet := prop_local("clipboard", record, Vector3(0, 1.0, 0.05), 0.0)
		sheet.rotation.x = -1.2
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
		var hum := sound3d(preload("res://assets/audio/patrol_hum.ogg"), patrol, -14.0, 14.0, true)
		hum.pitch_scale = 0.9 + i * 0.06
		patrol_alarms.append(sound3d(preload("res://assets/audio/patrol_alarm.ogg"), patrol, -6.0, 26.0, false))
		# The lamp must stay the last child: _process toggles it when stunned.
		patrol.move_child(lamp, patrol.get_child_count() - 1)
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
	quay_details()
	people()
	pump_effects()
	weather_effects()
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
	drop.size=Vector3(0.004,0.18,0.004)
	drop.material=material(Color("7e969f"))
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
	update_world_effects(delta)
	pulse.visible=campaign.pulse_ring>0
	if pulse.visible:
		pulse.position=world(campaign.position,0.05)
		pulse.scale=Vector3.ONE*maxf(0.1,(1-campaign.pulse_ring)*5.4)

# Software rendering: per-vertex light, no normal maps.
func simplify(mesh: MeshInstance3D) -> void:
	for surface in range(mesh.mesh.get_surface_count()):
		var mat: Material = mesh.get_active_material(surface)
		if mat is StandardMaterial3D:
			mat.shading_mode = BaseMaterial3D.SHADING_MODE_PER_VERTEX
			mat.normal_enabled = false

# Poly Haven props are authored in metres; they are centred and set on the ground.
func prop_local(file: String, parent: Node3D, at: Vector3, yaw_degrees: float) -> Node3D:
	var holder := Node3D.new()
	parent.add_child(holder)
	var scene: PackedScene = load("res://assets/props/%s.glb" % file.to_lower())
	var instance: Node3D = scene.instantiate()
	holder.add_child(instance)
	var b := bounds_of(instance)
	instance.position = Vector3(-b.get_center().x, -b.position.y, -b.get_center().z)
	for mesh in instance.find_children("*", "MeshInstance3D", true, false):
		mesh.visibility_range_end = 24.0 if low_quality else 60.0
		if low_quality:
			simplify(mesh)
	holder.position = at
	holder.rotation.y = deg_to_rad(yaw_degrees)
	return holder

func sound3d(stream: AudioStream, parent: Node3D, volume: float, reach: float, looping: bool) -> AudioStreamPlayer3D:
	var node := AudioStreamPlayer3D.new()
	var copy := stream.duplicate()
	if copy is AudioStreamOggVorbis:
		copy.loop = looping
	node.stream = copy
	node.volume_db = volume
	node.max_distance = reach
	node.unit_size = 3.0
	node.attenuation_model = AudioStreamPlayer3D.ATTENUATION_INVERSE_DISTANCE
	parent.add_child(node)
	sounds3d.append(node)
	if looping and DisplayServer.get_name() != "headless":
		node.play(randf() * 0.5)
	return node

func quay_details() -> void:
	for item in HarborData.PROPS:
		prop_local(item[0], self, world(item[1], item[3]), item[2])
	# Tyre fenders hang off the seaward face of the quay walls.
	for x in range(260, 2100, 460 if low_quality else 230):
		for edge in [[158.0, 0.0], [1382.0, 180.0]]:
			var tyre := prop_local("old_tyre", self, world(Vector2(x, edge[0]), -0.15), edge[1])
			tyre.rotation.x = 0.12
	if low_quality:
		# Extra lights cost a full pass per lit object in the compatibility renderer.
		return
	# Security floodlights on the warehouse walls.
	for item in HarborData.PROPS:
		if item[0] == "security_light":
			var lamp := OmniLight3D.new()
			var facing := Vector3(0, 0, 0.6).rotated(Vector3.UP, deg_to_rad(item[2]))
			lamp.position = world(item[1], item[3] - 0.2) + facing
			lamp.light_color = Color("e8f0ff")
			lamp.light_energy = 1.6
			lamp.omni_range = 7.0
			add_child(lamp)
	# Evacuation point: a working searchlight on the barrel, pointed at the gate.
	var beam := SpotLight3D.new()
	beam.position = world(Vector2(2138, 1108), 1.25)
	beam.rotation = Vector3(-0.35, deg_to_rad(110), 0)
	beam.light_color = Color("fff3d6")
	beam.light_energy = 3.0
	beam.spot_range = 14.0
	beam.spot_angle = 24.0
	add_child(beam)

func people() -> void:
	for i in range(HarborData.NPC_IDS.size()):
		npcs.append(person(HarborData.NPC_IDS[i], HarborData.NPC_POSITIONS[i], HarborData.NPC_YAW[i], HarborData.NPC_CLIPS[i]))
	for entry in HarborData.EVACUEES:
		person(entry[0], entry[1], entry[2], entry[3])
	# Dax works by torchlight: a real beam from his right hand.
	var skeleton: Skeleton3D = npcs[1].root.find_children("*", "Skeleton3D", true, false)[0]
	var grip := BoneAttachment3D.new()
	grip.bone_name = "hand_r"
	skeleton.add_child(grip)
	var torch_body := CylinderMesh.new()
	torch_body.top_radius = 0.022
	torch_body.bottom_radius = 0.018
	torch_body.height = 0.2
	var handle := MeshInstance3D.new()
	handle.mesh = torch_body
	handle.material_override = material(Color("26292b"))
	handle.rotation.z = PI / 2
	handle.position = Vector3(0.05, 0.03, 0)
	grip.add_child(handle)
	if low_quality:
		return
	var beam := SpotLight3D.new()
	beam.light_color = Color("fff1cf")
	beam.light_energy = 2.2
	beam.spot_range = 9.0
	beam.spot_angle = 22.0
	beam.position = Vector3(0.16, 0.03, 0)
	beam.rotation = Vector3(0, -PI / 2, 0)
	grip.add_child(beam)

func person(file: String, at: Vector2, yaw_degrees: float, clip: String) -> Dictionary:
	var root := Node3D.new()
	add_child(root)
	root.position = world(at)
	root.rotation.y = deg_to_rad(yaw_degrees)
	var scene: PackedScene = load("res://assets/characters/%s.glb" % file)
	var body: Node3D = scene.instantiate()
	root.add_child(body)
	for mesh in body.find_children("*", "MeshInstance3D", true, false):
		mesh.visibility_range_end = 26.0 if low_quality else 55.0
		if low_quality:
			simplify(mesh)
		for surface in range(mesh.mesh.get_surface_count()):
			var mat: Material = mesh.get_active_material(surface)
			# Clothing carries baked occlusion in its vertex colours.
			if mat is StandardMaterial3D and mat.resource_name.begins_with("Cloth"):
				mat.vertex_color_use_as_albedo = true
	var anim: AnimationPlayer = body.find_children("*", "AnimationPlayer", true, false)[0]
	for name in anim.get_animation_list():
		anim.get_animation(name).loop_mode = Animation.LOOP_LINEAR
	var base := clip_name(anim, clip)
	anim.play(base)
	anim.seek(randf() * 2.0, true)
	return {"root": root, "anim": anim, "base": base, "talk": 0.0, "at": at}

# Godot's importer drops a "_Loop" suffix from clip names; accept either form.
func clip_name(anim: AnimationPlayer, wanted: String) -> String:
	if anim.has_animation(wanted):
		return wanted
	var short := wanted.trim_suffix("_Loop")
	return short if anim.has_animation(short) else ""

func pump_effects() -> void:
	var water_drop := QuadMesh.new()
	water_drop.size = Vector2(0.09, 0.09)
	var spray := StandardMaterial3D.new()
	spray.albedo_color = Color(0.78, 0.88, 0.92, 0.55)
	spray.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	spray.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	spray.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	water_drop.material = spray
	for i in range(3):
		# Discharge pipe and its outflow, live once the pump is restored.
		var pipe := box(pumps[i], Vector3(0.16, 0.16, 0.7), Vector3(-0.55, 0.45, -0.1), material(Color("3b4d52")))
		pipe.rotation.y = PI / 2
		var flow := CPUParticles3D.new()
		flow.position = Vector3(-0.9, 0.45, -0.1)
		flow.emitting = false
		flow.amount = 24 if low_quality else 70
		flow.lifetime = 0.7
		flow.direction = Vector3(-1, 0.15, 0)
		flow.spread = 9
		flow.initial_velocity_min = 2.2
		flow.initial_velocity_max = 2.8
		flow.gravity = Vector3(0, -9.8, 0)
		flow.scale_amount_min = 0.6
		flow.scale_amount_max = 1.4
		flow.mesh = water_drop
		pumps[i].add_child(flow)
		outflows.append(flow)
		pump_sounds.append(sound3d(preload("res://assets/audio/pump_loop.ogg"), pumps[i], -10.0, 22.0, false))
		pump_sounds.append(sound3d(preload("res://assets/audio/outflow_loop.ogg"), pumps[i], -12.0, 14.0, false))

func weather_effects() -> void:
	# Waves break against the seawall; each source fires its own spray.
	var mist := QuadMesh.new()
	mist.size = Vector2(0.5, 0.5)
	var mist_material := StandardMaterial3D.new()
	mist_material.albedo_color = Color(0.82, 0.88, 0.9, 0.35)
	mist_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mist_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mist_material.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	mist.material = mist_material
	var clips := [preload("res://assets/audio/wave_a.ogg"), preload("res://assets/audio/wave_b.ogg")]
	for spot in [Vector2(420, 130), Vector2(1180, 130), Vector2(1900, 130), Vector2(800, 1410), Vector2(1600, 1410)]:
		var anchor := Node3D.new()
		anchor.position = world(spot, 0.2)
		add_child(anchor)
		var burst := CPUParticles3D.new()
		burst.emitting = false
		burst.one_shot = true
		burst.amount = 26
		burst.lifetime = 1.6
		burst.explosiveness = 0.85
		burst.emission_shape = CPUParticles3D.EMISSION_SHAPE_BOX
		burst.emission_box_extents = Vector3(2.5, 0.1, 0.3)
		burst.direction = Vector3(0, 1, 0.3 if spot.y > 700 else -0.3)
		burst.spread = 25
		burst.initial_velocity_min = 2.5
		burst.initial_velocity_max = 4.5
		burst.gravity = Vector3(0, -5, 0)
		burst.scale_amount_min = 0.6
		burst.scale_amount_max = 1.8
		burst.mesh = mist
		anchor.add_child(burst)
		var voice := sound3d(clips[waves.size() % 2], anchor, -8.0, 30.0, false)
		waves.append({"burst": burst, "voice": voice, "timer": randf_range(1.0, 7.0)})
	# Raindrops kick up from the paving around the player.
	splashes = CPUParticles3D.new()
	splashes.amount = 40
	splashes.lifetime = 0.25
	splashes.emission_shape = CPUParticles3D.EMISSION_SHAPE_BOX
	splashes.emission_box_extents = Vector3(5, 0.01, 5)
	splashes.direction = Vector3(0, 1, 0)
	splashes.spread = 35
	splashes.initial_velocity_min = 0.6
	splashes.initial_velocity_max = 1.2
	splashes.gravity = Vector3(0, -9.8, 0)
	var droplet := QuadMesh.new()
	droplet.size = Vector2(0.035, 0.035)
	var droplet_material := mist_material.duplicate()
	droplet_material.albedo_color = Color(0.8, 0.88, 0.9, 0.6)
	droplet.material = droplet_material
	splashes.mesh = droplet
	add_child(splashes)

# During a conversation the camera settles on the speaker.
func focus(index: int) -> void:
	focus_npc = index

func speak(index: int, seconds: float) -> void:
	if index < 0 or index >= npcs.size():
		return
	var npc: Dictionary = npcs[index]
	npc.talk = seconds
	var talking := clip_name(npc.anim, "Idle_Talking_Loop")
	if npc.base != "Fixing_Kneeling" and not talking.is_empty():
		npc.anim.play(talking, 0.35)

func alarm_cue() -> void:
	damage_flash = maxf(damage_flash, 0.7)

func update_world_effects(delta: float) -> void:
	for node in sounds3d:
		node.stream_paused = not sound_enabled
	# Lightning: a flicker in the cloud base, then thunder after a distance delay.
	next_strike -= delta
	if next_strike <= 0.0 and not menu:
		next_strike = randf_range(10.0, 24.0)
		thunder_strength = randf_range(0.35, 1.0)
		thunder_delay = lerpf(2.6, 0.5, thunder_strength)
		if not reduced_motion:
			flash = thunder_strength
	if thunder_delay >= 0.0:
		thunder_delay -= delta
		if thunder_delay < 0.0:
			thunder.emit(thunder_strength)
	flash = maxf(0.0, flash - delta * 2.6)
	var flicker := flash * (0.6 + 0.4 * sin(elapsed * 60.0))
	# Touch the sky only while lightning is visible; any change re-renders it.
	if flicker > 0.0 or sky_flash > 0.0:
		sky_flash = flicker
		sky_material.set_shader_parameter("flash", flicker)
		sun.light_energy = 0.95 + flicker * 2.2
		environment.ambient_light_energy = 0.60 + flicker * 0.9
	for wave in waves:
		wave.timer -= delta
		if wave.timer <= 0.0:
			wave.timer = randf_range(4.0, 9.0)
			if not reduced_motion and not low_quality:
				wave.burst.restart()
			if sound_enabled and DisplayServer.get_name() != "headless":
				wave.voice.pitch_scale = randf_range(0.85, 1.1)
				wave.voice.play()
	splashes.emitting = not reduced_motion and not menu and not low_quality
	splashes.position = Vector3(eyes.position.x, 0.02, eyes.position.z)
	for i in range(3):
		var running: bool = campaign.pumps[i]
		outflows[i].emitting = running and not reduced_motion
		for node in [pump_sounds[i * 2], pump_sounds[i * 2 + 1]]:
			if running and not node.playing and DisplayServer.get_name() != "headless":
				node.stream.loop = true
				node.play()
			elif not running and node.playing:
				node.stop()
	for i in range(4):
		var alert: float = campaign.drones[i].alert
		if alert > 0.55 and patrol_alert[i] <= 0.55 and sound_enabled and DisplayServer.get_name() != "headless":
			patrol_alarms[i].play()
		patrol_alert[i] = alert
	for i in range(npcs.size()):
		var npc: Dictionary = npcs[i]
		if npc.talk > 0.0:
			npc.talk -= delta
			if npc.talk <= 0.0 and npc.anim.current_animation != npc.base:
				npc.anim.play(npc.base, 0.45)
		# Standing speakers turn to face Mara while she talks to them.
		if i == focus_npc and npc.base != "Fixing_Kneeling":
			var to_player: Vector2 = campaign.position - npc.at
			npc.root.rotation.y = lerp_angle(npc.root.rotation.y, atan2(to_player.x, to_player.y), 1.0 - exp(-delta * 3.0))
	if focus_npc >= 0 and not menu:
		var npc: Dictionary = npcs[focus_npc]
		var head: Vector3 = world(npc.at, 1.05 if npc.base == "Fixing_Kneeling" else 1.6)
		var to_head := head - eyes.position
		var want_yaw := atan2(-to_head.x, -to_head.z)
		var want_pitch := atan2(to_head.y, Vector2(to_head.x, to_head.z).length())
		yaw = lerp_angle(yaw, want_yaw, 1.0 - exp(-delta * 4.0))
		pitch = lerpf(pitch, want_pitch, 1.0 - exp(-delta * 4.0))

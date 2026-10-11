class_name HarborData
extends RefCounted

const START := Vector2(430, 1190)
const EXIT := Vector2(2080, 1170)
const BOUNDS := Rect2(140, 160, 2020, 1220)
const CANAL := Rect2(1390, 630, 770, 140)
const BRIDGES := [Rect2(1580, 620, 110, 160), Rect2(1950, 620, 110, 160)]
const BUILDINGS := [
	Rect2(270, 260, 550, 290), Rect2(920, 890, 360, 230),
	Rect2(1500, 230, 490, 280), Rect2(660, 1030, 150, 120),
	Rect2(350, 670, 90, 110), Rect2(850, 670, 230, 90),
	Rect2(1160, 210, 130, 100), Rect2(1720, 870, 200, 90)
]
const PUMPS := [Vector2(560, 850), Vector2(1240, 440), Vector2(1820, 1080)]
const PUMP_NAMES := ["DEPOT / P-01", "NORTH WEIR / P-02", "EAST DOCK / P-03"]
const TARGETS := [[0, 1, 3], [2, 0, 1], [1, 3, 2]]
const FUSES := [Vector2(340, 1060), Vector2(930, 450), Vector2(1560, 1160)]
const LOGS := [Vector2(580, 600), Vector2(1390, 390), Vector2(1970, 1000)]
const LOG_TEXT := [
	"SERA / 06:12\nValve P-01 was placed in emergency hold by a person, not an algorithm. The signature field is blank. Bring it back by hand.",
	"DAX / 06:19\nThere's a 37-minute hole between the evacuation order and the gate closure. I found the printed shift sheet. It hasn't got a hole.",
	"IVO / 06:27\nSix oxygen units. Four batteries. I kept the clinic feeder live and let the east dock lose power. Put that in your report, too."
]
const PATROLS := [
	[Vector2(700, 810), Vector2(1080, 810), Vector2(1080, 570), Vector2(700, 570)],
	[Vector2(910, 380), Vector2(1390, 380), Vector2(1390, 570), Vector2(910, 570)],
	[Vector2(1460, 1020), Vector2(1660, 1020), Vector2(1660, 1230), Vector2(1460, 1230)],
	[Vector2(2000, 810), Vector2(2000, 1060), Vector2(1940, 1060), Vector2(1940, 810)]
]
const DIRECTIONS := ["N", "E", "S", "W"]
# People on the quay. Sera waits beyond the east gate with two evacuees.
const NPC_IDS := ["ivo", "dax", "sera"]
const NPC_POSITIONS := [Vector2(598, 1112), Vector2(1100, 302), Vector2(2088, 1296)]
const NPC_YAW := [122.0, -34.0, -176.0]
const NPC_CLIPS := ["Fixing_Kneeling", "Idle_Torch_Loop", "Idle_Loop"]
const EVACUEES := [["evacuee_a", Vector2(2128, 1205), -90.0, "Sitting_Talking_Loop"], ["evacuee_b", Vector2(2128, 1288), -90.0, "Sitting_Idle_Loop"]]
# Poly Haven props: [model, position, yaw degrees, mount height m, solid footprint in units].
const PROPS := [
	["portable_generator", Vector2(636, 1088), 20.0, 0.0, Vector2.ZERO],
	["medical_box", Vector2(578, 1140), -15.0, 0.0, Vector2.ZERO],
	["metal_toolbox", Vector2(626, 1132), 40.0, 0.0, Vector2.ZERO],
	["propane_tank", Vector2(652, 1128), 0.0, 0.0, Vector2.ZERO],
	["propane_tank", Vector2(650, 1146), 0.0, 0.0, Vector2.ZERO],
	["barrel_01", Vector2(1128, 318), 0.0, 0.0, Vector2(32, 32)],
	["clipboard", Vector2(1128, 318), 20.0, 0.885, Vector2.ZERO],
	["portable_generator", Vector2(630, 822), 90.0, 0.0, Vector2(32, 44)],
	["portable_generator", Vector2(1310, 412), 90.0, 0.0, Vector2(32, 44)],
	["portable_generator", Vector2(1890, 1052), 90.0, 0.0, Vector2(32, 44)],
	["barrel_01", Vector2(292, 572), 0.0, 0.0, Vector2(32, 32)],
	["barrel_03", Vector2(326, 574), 30.0, 0.0, Vector2(34, 34)],
	["plastic_crate_03", Vector2(762, 566), 10.0, 0.0, Vector2(28, 20)],
	["plastic_crate_03", Vector2(762, 566), -8.0, 0.27, Vector2.ZERO],
	["trashbag", Vector2(872, 1138), 0.0, 0.0, Vector2(30, 28)],
	["trashbag", Vector2(902, 1134), 70.0, 0.0, Vector2(30, 28)],
	["hand_truck", Vector2(1300, 1098), -30.0, 0.0, Vector2(34, 34)],
	["metal_jerrycan_green", Vector2(1738, 975), 15.0, 0.0, Vector2(22, 22)],
	["barrel_03", Vector2(1975, 528), 0.0, 0.0, Vector2(34, 34)],
	["modular_street_seating", Vector2(2140, 1240), 90.0, 0.0, Vector2(40, 218)],
	["medical_box", Vector2(2098, 1112), 80.0, 0.0, Vector2(28, 30)],
	["barrel_03", Vector2(2138, 1108), 0.0, 0.0, Vector2(34, 34)],
	["portable_searchlight", Vector2(2138, 1108), 230.0, 0.93, Vector2.ZERO],
	["security_light", Vector2(545, 551), 180.0, 3.1, Vector2.ZERO],
	["security_light", Vector2(1100, 889), 0.0, 3.1, Vector2.ZERO],
	["security_light", Vector2(1745, 511), 180.0, 3.1, Vector2.ZERO],
	["lifebuoy", Vector2(700, 169), 0.0, 0.55, Vector2.ZERO],
	["lifebuoy", Vector2(1450, 169), 0.0, 0.55, Vector2.ZERO],
	["lifebuoy", Vector2(1200, 1371), 180.0, 0.55, Vector2.ZERO],
]
const NPC_RADIUS := 22.0
# The fenced yard in front of North Weir Works, used for a radio cue.
const WEIR_YARD := Rect2(1300, 160, 860, 450)

static func solids() -> Array[Rect2]:
	var result: Array[Rect2] = []
	for p in NPC_POSITIONS:
		result.append(Rect2(p - Vector2(NPC_RADIUS, NPC_RADIUS), Vector2(NPC_RADIUS, NPC_RADIUS) * 2))
	# Ivo's work station: generator, oxygen units and kit.
	result.append(Rect2(566, 1070, 100, 88))
	for prop in PROPS:
		var size: Vector2 = prop[4]
		if size != Vector2.ZERO:
			result.append(Rect2(prop[1] - size / 2, size))
	return result

static var SOLID_CACHE: Array[Rect2] = solids()

static func blocked(p: Vector2, radius: float = 15.0, gate_open: bool = false) -> bool:
	if not BOUNDS.grow(-radius).has_point(p):
		return true
	for box in BUILDINGS:
		if box.grow(radius).has_point(p):
			return true
	for pump in PUMPS:
		if p.distance_to(pump) < radius + 30.0:
			return true
	for box in SOLID_CACHE:
		if box.grow(radius).has_point(p):
			return true
	if CANAL.grow(radius).has_point(p):
		var bridge := false
		for box in BRIDGES:
			if box.grow_individual(-radius, radius, -radius, radius).has_point(p):
				bridge = true
		if not bridge:
			return true
	if not gate_open and Rect2(2020, 1090, 28, 270).grow(radius).has_point(p):
		return true
	return false

static func clear_sight(a: Vector2, b: Vector2) -> bool:
	for i in range(1, 12):
		var point := a.lerp(b, float(i) / 12.0)
		for box in BUILDINGS:
			if box.has_point(point):
				return false
	return true

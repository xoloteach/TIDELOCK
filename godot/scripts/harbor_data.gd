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

static func blocked(p: Vector2, radius: float = 15.0, gate_open: bool = false) -> bool:
	if not BOUNDS.grow(-radius).has_point(p):
		return true
	for box in BUILDINGS:
		if box.grow(radius).has_point(p):
			return true
	for pump in PUMPS:
		if p.distance_to(pump) < radius + 30.0:
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

class_name Lore
extends RefCounted

# World-building content for Morrow Quay: readable notices, location radio,
# ambient lines and the two evacuees. Written to stay inside what the shift
# logs already establish; nothing here names who gave the hold order.

# [title, text, Vector2(x, y), yaw_degrees, wall]
# Position is 12 units off the named wall face. Yaw is the direction the sheet
# faces (0 = north / -y, 90 = east / +x, 180 = south, 270 = west); it faces away
# from the wall. All spots are >= 140 units from FUSES, PUMPS (+70 y), LOGS,
# START and EXIT, and >= 88 units from every patrol leg. The wall field is for
# the implementer only (index into HarborData.BUILDINGS, or the east gate).
const NOTES := [
	["NOTICE / BOROUGH STORES",
		"STORES CLOSED UNTIL FURTHER NOTICE.\nCollect fuses and regulator collars from the contractor crates.\nSign the sheet. There is a sheet.",
		Vector2(822, 1090), 90.0, "B3 east wall, beside Ivo's station"],
	["TAPED NOTICE / EVACUATION",
		"EVACUATION IN FORCE. All residents to the east gate. Do not use the canal bridges after the water passes the second rail. Issued from the harbour desk.",
		Vector2(258, 400), 270.0, "B0 west wall"],
	["NOTICEBOARD / SHIFT CHANGE",
		"Night shift: 3 pumps, 2 crew.\nDay shift: see night shift.\nWhoever has the key to the weir hut, it is on a green fob and it is not yours.",
		Vector2(338, 720), 270.0, "B4 west wall"],
	["WHITEBOARD / P-03 HUT",
		"P-03 MANUAL HOLD\nDo not cycle. Do not log. Await instruction.\n(instruction rubbed out)",
		Vector2(1830, 972), 180.0, "B7 south wall, east dock pump hut"],
	["CONTRACTOR TAG / WEIR VALVE",
		"INSPECTED: PASS\nHold position set from remote.\nInspector initials: smudged. Date: yesterday's.",
		Vector2(1302, 260), 90.0, "B6 east wall, weir valve housing"],
	["GRAFFITI / STORES WALL",
		"THE WATER READ THE SCHEDULE\nTOO.\nSomeone has added underneath: Who wrote the schedule?",
		Vector2(1100, 1132), 180.0, "B1 south wall"],
	["DRAWING / EVACUEE AREA",
		"A child's drawing of the quay in felt-tip. Three pumps with faces. One pump has its hand up. The sky is green. Underneath: ALL OF US.",
		Vector2(2058, 1340), 90.0, "east gate fence, south end"],
	["QUAY LEDGER / FRONT PAGE",
		"WHO TURNED THEM DOWN?\nTwo pumps eased off ten seconds apart. The borough calls it a fault. The crew calls it a hand. Page 3: the missing minutes.",
		Vector2(960, 658), 0.0, "B5 north wall"],
	["TIMETABLE / MORROW FERRY",
		"MORROW QUAY - HALF-LANDING\nLast crossing: cancelled\nNext crossing: see harbour desk\nBarge slots for medical freight take priority over foot passengers.",
		Vector2(1750, 218), 0.0, "B2 north wall"],
	["UNION ROTA / PUMP CREWS",
		"NIGHT ROTA - 3 pumps\nP-01: two names, both struck through\nP-02: one name, a tick\nP-03: unfilled, shift swapped by phone. No name written for the swap.",
		Vector2(500, 248), 0.0, "B0 north wall"],
]

# Fired once each. Keys: bridge (first bridge crossing), weir_yard (entering the
# north weir yard), canal (approaching the canal), log_1, log_2, log_3 (after
# reading that log), tide_2min (when the tide timer passes 2 minutes), rescue
# (after a rescue). Lines are [speaker, text].
const RADIO_EVENTS := {
	"bridge": [
		["sera", "You're on the bridge. It's rated for a person and a bad attitude. Keep walking."],
		["mara", "Water's at the second rail."],
		["sera", "Then don't stop to measure it."],
	],
	"weir_yard": [
		["control", "Weir yard, you are inside the P-02 enclosure. Telemetry shows you as unlisted."],
		["mara", "Mara Venn. Recovery."],
		["control", "Noted. It shows nobody on the hold either."],
	],
	"canal": [
		["barge", "Quay, this is the barge. We can see a torch on the south bank. Is that one of yours?"],
		["sera", "It's the technician. Hold your slot, we'll get the pumps drawing first."],
	],
	"log_1": [
		["sera", "You've got the first sheet. Blank signature field. I've read that line forty times and it hasn't filled in."],
		["mara", "Who has hand access to the valve?"],
		["sera", "Come back to the desk and I'll tell you who had a key. Not who used it."],
	],
	"log_2": [
		["dax", "Venn. Tell me you found the printed sheet."],
		["mara", "It has no hole in it."],
		["dax", "Then somebody cut the tablet, not the minutes. Keep that off the air. Say it to me in person."],
	],
	"log_3": [
		["ivo", "I heard the east dock go dark when you pulled that. Don't apologise, it's been dark for hours."],
		["mara", "Your log says you let it."],
		["ivo", "I let it. I'd do it again. Oxygen first, lamps second."],
	],
	"tide_2min": [
		["control", "Tide gauge at Dock Four reads two minutes on the clock. Advise."],
		["sera", "Advice is noted. We're not asking for a new number, we're asking for the pumps."],
	],
	"rescue": [
		["sera", "That's another one through the east gate. Count her in."],
		["barge", "We heard it on the water. Whoever that was, they're dry. Barge appreciates the work."],
	],
}

# Said when the player walks within ~90 units after the NPC's conversation.
# Pick at random, never twice in a row. evacuee_a and evacuee_b use the name in
# EVACUEES; the subtitle speaker should be the name, not the id.
const BARKS := {
	"ivo": [
		["ivo", "Three good batteries. I keep counting the fourth in case it improves."],
		["ivo", "If the readout says clean again, let me hold the paper, not you. I'll chew on it."],
		["ivo", "Don't lean on the generator. It sulks."],
	],
	"dax": [
		["dax", "Ten seconds apart. I keep saying it aloud to see if it sounds like an accident."],
		["dax", "Anyone can print a headline. I'd like to print a time."],
		["dax", "The photocopier jammed on the word municipal. I took it personally."],
	],
	"sera": [
		["sera", "Beacon's lit when you want it. I'm not going anywhere."],
		["sera", "I can read the board from here. The board isn't who I'm waiting on."],
		["sera", "Eat something. That's on the desk's authority."],
	],
	"evacuee_a": [
		["evacuee_a", "My sister said the pumps sang a note before they went down. I wrote the note on my hand."],
		["evacuee_a", "Is the gate opening on its own now? It does the half-lift. Like it's thinking."],
	],
	"evacuee_b": [
		["evacuee_b", "Don't tell the desk. He's been in my coat since the second rail."],
		["evacuee_b", "I sat at the east gate with the engine running. Nobody said go. Nobody said stay."],
	],
}

# Names, one human detail each, and a closing line per ending. Shown after the
# ending screen text, or as a caption beneath it.
const EVACUEES := {
	"evacuee_a": {
		"name": "ODILE MARSH",
		"detail": "Retired ferry clerk. Still counts people in tens, the way she counted tickets.",
		"epilogue": {
			"broadcast": "ODILE / Read it out at the east gate if you have to. I counted the pumps going down. Ten seconds. I'll say it to anyone.",
			"archive": "ODILE / Somebody official is writing it down. I'd rather that than the half of the quay who already think they know.",
		},
	},
	"evacuee_b": {
		"name": "TOMAS QUILL",
		"detail": "Bakery van driver. Has a cat called Pilot inside his yellow raincoat.",
		"epilogue": {
			"broadcast": "TOMAS / My mother's going to read it over the shop counter. I'd rather she read it from the paper than from me.",
			"archive": "TOMAS / A file is a quiet place for a long night. Pilot and I will wait in the van. Somebody will call.",
		},
	},
}

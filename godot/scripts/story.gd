class_name Story
extends RefCounted

# Authored scenes, adapted from the TIDELOCK prologue and act one scripts for
# Morrow Quay. A line is [speaker, text]; a choice line is [speaker, text,
# [[option, reply speaker, reply, flag], ...]].
const SPEAKERS := {
	"mara": ["MARA VENN", Color("e6e4cc")],
	"sera": ["SERA HOLT", Color("f0a35a")],
	"ivo": ["IVO", Color("8fd3c4")],
	"dax": ["DAX REN", Color("d8c27a")],
}

const RADIO_INTRO := [
	["sera", "Your tool just registered on the depot node. Check the charge before you go anywhere."],
	["mara", "Half."],
	["sera", "Half is enough. Don't pulse anything you don't have to."],
	["mara", "Why not?"],
	["sera", "The maintenance units read a pulse as a work order. Stay out of their lamps and they'll leave you alone."],
	["sera", "Three pumps on the quay, all in manual hold. Fuses are in the contractor crates. Holt out."],
]
const RADIO_SPOTTED := [
	["sera", "That's a work order you've just been issued. Get out of its lamp."],
]
const RADIO_FIRST_PUMP := [
	["sera", "I can see it on the board from here. Two to go."],
	["mara", "Ivo's clinic?"],
	["sera", "On the feeder. Keep moving."],
]
const RADIO_GATE := [
	["sera", "East gate's lifting. I'm on the other side of it with two people who'd like to go home."],
]

const SCENES := {
	"ivo": [
		["ivo", "If that's the generator man, he's ninety minutes late and I've started making things up about his family."],
		["mara", "It's Venn."],
		["ivo", "Mara. Hold this a second, the thread's crossed."],
		["ivo", "Regulator collar. They come five to a bag and two are always the wrong pitch."],
		["ivo", "Six oxygen units and four batteries. That's the clinic until the barge gets a slot."],
		["mara", "Four good ones?"],
		["ivo", "Three good ones and one that lies about how full it is."],
		["ivo", "The contractor's readout says the pumps are clean. I'd like a second number from someone who's read one before.", [
			["What number are you expecting?", "ivo", "Two-thirty at the terminals. It read two-thirty an hour ago as well, which is the part I don't like.", "ivo_numbers"],
			["When did you last sleep?", "ivo", "Tuesday. Don't do the arithmetic in front of me.", "ivo_trust"],
			["Who signed off on the contractor's readout?", "ivo", "A man with a clipboard and a lanyard. I didn't get the name off the lanyard.", "ivo_contractor"],
		]],
		["ivo", "Nobody on this quay read that report, by the way."],
		["mara", "The depot pump, then."],
		["ivo", "The depot pump. Fuse crate's by the stores. Mind the machines."],
	],
	"dax": [
		["dax", "Third time I've asked anyone. Who signed the closure on the weir? A name, not a department."],
		["mara", "Mara Venn. I'm here for a pump."],
		["dax", "Dax Ren. I print the Quay Ledger: four pages and a photocopier. Night of the surge, two of three pumps off at 02:31. Whose order?"],
		["dax", "The crew says they didn't trip. They eased off, one after another, ten seconds apart. Like somebody turning a tap down."],
		["mara", "Ten seconds is a ramp. Not a breaker."],
		["dax", "You're carrying a paper set with wet corners. Holt doesn't ask for paper when the tablet's right. Does the valve schedule match?", [
			["It doesn't match.", "dax", "Doesn't match. Good. I'll print \"a municipal technician on site\" and you'll hate that, and it'll still be true.", "dax_mismatch"],
			["Ask whoever updated it.", "dax", "\"Whoever updated it.\" Not \"they match.\" Ten minutes on the quay and you already sound like the office.", "dax_office"],
			["Keep her name out of it.", "dax", "Her name for a walk to a gate I got over on my own. Fine. Keep her. I'll take the ten seconds.", "dax_protect"],
		]],
		["dax", "The borough report gives me 02:14, then 03:06. In between I have four dispatch calls with receipts, and not one of them is on that page."],
		["dax", "If the pump logs say overcurrent, come and tell me so. If they don't, come faster."],
	],
	"sera": [
		["sera", "You came through the east gate on your own. It's rated for two."],
		["mara", "It lifts for one. Slowly."],
		["sera", "The water's below the clinic sill. You can stop now."],
		["sera", "The recovery team wants the shift logs on paper. Ren wants them in print.", [
			["Who gave the hold order?", "sera", "Somebody who knew the tablet would be believed. Read the logs. I won't say it for you.", "sera_order"],
			["Are they safe here?", "sera", "Dry, fed and arguing about the radio. That's safe for tonight.", "sera_evacuees"],
		]],
		["sera", "Walk to the beacon when you're ready. I'll sign whatever you file."],
	],
}
const REPEAT := {
	"ivo": ["ivo", "The depot pump. Then the weir. Go on."],
	"dax": ["dax", "02:14 to 03:06. Bring me the logs."],
	"sera": ["sera", "The beacon's lit. Take your time."],
}

static func speaker_name(id: String) -> String:
	return SPEAKERS.get(id, [id.to_upper(), Color.WHITE])[0]

static func speaker_color(id: String) -> Color:
	return SPEAKERS.get(id, ["", Color.WHITE])[1]

# Seconds a subtitle stays up: long enough to read at a comfortable pace.
static func duration(text: String) -> float:
	return clampf(1.4 + text.length() * 0.055, 2.2, 9.0)

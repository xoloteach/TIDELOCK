class_name Soundscape
extends Node

var enabled := true
var ambience: AudioStreamPlayer
var tones: AudioStreamPlayer
var steps: AudioStreamPlayer
var step_index := 0
const FOOTSTEPS := [preload("res://assets/impact/footstep_concrete_000.ogg"), preload("res://assets/impact/footstep_concrete_001.ogg"), preload("res://assets/impact/footstep_concrete_002.ogg")]
const CUES := {"error": preload("res://assets/interface/error_001.ogg"), "click": preload("res://assets/interface/click_001.ogg"), "repair": preload("res://assets/interface/confirmation_001.ogg"), "damage": preload("res://assets/impact/impactMetal_heavy_000.ogg"), "pulse": preload("res://assets/interface/glitch_001.ogg")}

func _ready() -> void:
	ambience = AudioStreamPlayer.new()
	add_child(ambience)
	tones = AudioStreamPlayer.new()
	add_child(tones)
	steps = AudioStreamPlayer.new()
	steps.volume_db = -18
	add_child(steps)
	if DisplayServer.get_name() == "headless":
		return
	var sample_rate := 22050
	var samples := sample_rate * 4
	var bytes := PackedByteArray()
	bytes.resize(samples * 2)
	var rng := RandomNumberGenerator.new()
	rng.seed = 7321
	var low := 0.0
	for i in range(samples):
		low = low * 0.94 + rng.randf_range(-1.0, 1.0) * 0.06
		var wind := low * 0.3 + rng.randf_range(-1.0, 1.0) * 0.02
		bytes.encode_s16(i * 2, int(wind * 32767))
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = sample_rate
	stream.data = bytes
	stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
	stream.loop_end = samples
	ambience.stream = stream
	ambience.volume_db = -13
	ambience.play()

func set_enabled(value: bool) -> void:
	enabled = value
	ambience.volume_db = -13 if enabled else -80
	tones.volume_db = -9 if enabled else -80

func cue(kind: String) -> void:
	if not enabled:
		return
	tones.stream = CUES.get(kind, CUES.click)
	tones.play()

func step() -> void:
	if enabled and DisplayServer.get_name() != "headless":
		steps.stream = FOOTSTEPS[step_index % FOOTSTEPS.size()]
		step_index += 1
		steps.play()

func _exit_tree() -> void:
	if is_instance_valid(ambience):
		ambience.stop()
		ambience.stream = null
	if is_instance_valid(tones):
		tones.stop()
		tones.stream = null

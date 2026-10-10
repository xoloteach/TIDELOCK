class_name Soundscape
extends Node

var enabled := true
var ambience: AudioStreamPlayer
var rain: AudioStreamPlayer
var tones: AudioStreamPlayer
var radio: AudioStreamPlayer
var steps: AudioStreamPlayer
var weather: AudioStreamPlayer
var step_index := 0
const WET_STEPS := [preload("res://assets/audio/step_wet_1.ogg"), preload("res://assets/audio/step_wet_2.ogg"), preload("res://assets/audio/step_wet_3.ogg")]
const METAL_STEPS := [preload("res://assets/audio/step_metal_1.ogg"), preload("res://assets/audio/step_metal_2.ogg"), preload("res://assets/audio/step_metal_3.ogg")]
const CUES := {"error": preload("res://assets/interface/error_001.ogg"), "click": preload("res://assets/interface/click_001.ogg"), "repair": preload("res://assets/interface/confirmation_001.ogg"), "damage": preload("res://assets/impact/impactMetal_heavy_000.ogg"), "pulse": preload("res://assets/interface/glitch_001.ogg"), "valve": preload("res://assets/audio/valve.ogg"), "gate": preload("res://assets/audio/gate_release.ogg")}
const RAIN := preload("res://assets/audio/rain_loop.ogg")
const THUNDER := preload("res://assets/audio/thunder.ogg")
const STATIC := preload("res://assets/audio/radio_static.ogg")

func player(volume: float) -> AudioStreamPlayer:
	var node := AudioStreamPlayer.new()
	node.volume_db = volume
	add_child(node)
	return node

func _ready() -> void:
	ambience = player(-13)
	rain = player(-9)
	tones = player(-9)
	radio = player(-16)
	steps = player(-15)
	weather = player(-6)
	if DisplayServer.get_name() == "headless":
		return
	# A low synthesised wind bed sits under the recorded rain loop.
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
	ambience.play()
	var loop: AudioStreamOggVorbis = RAIN.duplicate()
	loop.loop = true
	rain.stream = loop
	rain.play()

func set_enabled(value: bool) -> void:
	enabled = value
	for node in [ambience, rain, tones, radio, steps, weather]:
		node.stream_paused = not enabled
	ambience.volume_db = -13 if enabled else -80
	rain.volume_db = -9 if enabled else -80
	tones.volume_db = -9 if enabled else -80

func cue(kind: String) -> void:
	if not enabled:
		return
	if kind == "radio":
		radio.stream = STATIC
		radio.play()
		return
	tones.stream = CUES.get(kind, CUES.click)
	tones.play()

func thunder(strength: float) -> void:
	if not enabled or DisplayServer.get_name() == "headless":
		return
	weather.stream = THUNDER
	weather.volume_db = lerpf(-16.0, -4.0, strength)
	weather.pitch_scale = randf_range(0.8, 1.05)
	weather.play()

func step(metal: bool = false) -> void:
	if enabled and DisplayServer.get_name() != "headless":
		var pool: Array = METAL_STEPS if metal else WET_STEPS
		steps.stream = pool[step_index % pool.size()]
		steps.pitch_scale = randf_range(0.92, 1.08)
		step_index += 1
		steps.play()

func _exit_tree() -> void:
	for node in [ambience, rain, tones, radio, steps, weather]:
		if is_instance_valid(node):
			node.stop()
			node.stream = null

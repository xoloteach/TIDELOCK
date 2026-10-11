shader_type spatial;
// Harbour-light beam: an additive cone that fades with length and with distance.
// fog_disabled plus its own attenuation, otherwise Godot adds fog colour to additive surfaces.
render_mode unshaded, blend_add, depth_draw_never, cull_disabled, fog_disabled;
uniform vec3 tint = vec3(1.0, 0.93, 0.75);
uniform float strength = 0.35;
varying float t;
void vertex() { t = (19.0 - VERTEX.y) / 38.0; }          // 0 at the lantern
void fragment() {
	float side = abs(dot(normalize(NORMAL), normalize(VIEW)));
	ALBEDO = tint * strength * pow(clamp(1.0 - t, 0.0, 1.0), 1.5) * side * exp(-0.012 * length(VERTEX));
}

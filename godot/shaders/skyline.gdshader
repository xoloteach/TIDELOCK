shader_type spatial;
// Distant city silhouettes: unshaded (fog still applies) with procedural lit windows.
// One material is shared by every building so the backdrop pays a single draw call for them.
render_mode unshaded, cull_back;
uniform sampler2D palette : source_color, filter_nearest;
uniform float lit = 0.02;                    // window fraction; raised as pumps return
uniform vec3 body = vec3(0.12, 0.15, 0.17);
varying vec3 wp;
varying vec3 wn;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void vertex() {
	wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	wn = abs(normalize((MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz));
}
void fragment() {
	vec3 base = texture(palette, UV).rgb * body * 2.0;
	vec2 f = (wn.x > wn.z ? wp.zy : wp.xy) / vec2(2.2, 3.0);   // 2.2 m bays, 3 m floors
	vec2 c = fract(f);
	float win = step(0.25, c.x) * step(c.x, 0.75) * step(0.3, c.y) * step(c.y, 0.75) * step(0.6, wn.x + wn.z);
	float on = step(hash(floor(f) + floor(wp.xz * 0.11) * 17.0), lit) * win;
	ALBEDO = base + vec3(1.0, 0.72, 0.38) * on * 1.4;
}

shader_type spatial;
render_mode blend_mix, depth_draw_never, cull_disabled;
// Standing water on the quay: an irregular dark edge, a mirror-smooth middle that
// picks up the storm sky, and rain rings that open and fade across it.
uniform float seed = 0.0;
uniform float ripples = 1.0;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void fragment(){
	vec2 p = UV - 0.5;
	float edge = length(p * vec2(1.0, 1.3)) + (noise(UV * 5.0 + seed) - 0.5) * 0.28;
	float wet = 1.0 - smoothstep(0.30, 0.46, edge);
	if (wet <= 0.01) discard;
	vec3 n = vec3(0.0, 0.0, 1.0);
	// Four staggered rain rings per cell; each grows and fades over ~0.9 s.
	vec2 cell_uv = UV * 9.0;
	for (int k = 0; k < 2; k++) {
		vec2 cell = floor(cell_uv + float(k) * 0.5);
		vec2 centre = cell + vec2(hash(cell + seed), hash(cell.yx + seed + 4.0)) - float(k) * 0.5;
		float t = fract(TIME * 1.1 + hash(cell * 1.7 + seed));
		vec2 d = cell_uv - centre;
		float r = length(d);
		float ring = sin((r - t * 0.55) * 60.0) * smoothstep(0.08, 0.0, abs(r - t * 0.55)) * (1.0 - t);
		n.xy += normalize(d + 1e-4) * ring * 0.35 * ripples;
	}
	NORMAL_MAP = normalize(n) * 0.5 + 0.5;
	ALBEDO = vec3(0.025, 0.035, 0.04);
	ROUGHNESS = 0.04;
	METALLIC = 0.0;
	SPECULAR = 0.9;
	ALPHA = wet * 0.82;
}

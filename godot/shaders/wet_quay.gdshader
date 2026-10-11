shader_type spatial;
// The quay floor, laid out like a real working dock: cast concrete slabs with
// sealed expansion joints, a band of granite setts along every quay and canal
// edge, and an asphalt service road on the south dock. Each slab gets its own
// texture offset and tint so the concrete never tiles visibly, and rain pools
// in the low spots, darkening and smoothing whatever it covers.
uniform sampler2D slab_color : source_color, filter_linear_mipmap, repeat_enable;
uniform sampler2D slab_normal : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2D setts_color : source_color, filter_linear_mipmap, repeat_enable;
uniform sampler2D setts_normal : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2D asphalt_color : source_color, filter_linear_mipmap, repeat_enable;
uniform sampler2D asphalt_normal : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2D roughness_pack : filter_linear_mipmap, repeat_enable;
// Playable quay and canal, in metres (map units / 50).
uniform vec4 quay = vec4(2.8, 3.2, 43.2, 27.6);
uniform vec4 canal = vec4(27.8, 12.6, 43.2, 15.4);
uniform vec2 road = vec2(23.7, 26.5);
varying vec3 world_point;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float rect_distance(vec2 p, vec4 r){vec2 d=max(r.xy-p,p-r.zw);return length(max(d,0.0))+min(max(d.x,d.y),0.0);}
void vertex(){world_point=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;}
void fragment(){
	vec2 p = world_point.xz;
	// Surface masks: setts within 2.2 m of the quay edge or 1.4 m of the canal.
	float edge = -rect_distance(p, quay);
	float to_canal = rect_distance(p, canal);
	float setts = 1.0 - smoothstep(2.1, 2.25, min(edge, to_canal + 0.8));
	float asphalt = (1.0 - setts) * smoothstep(road.x - 0.08, road.x, p.y) * (1.0 - smoothstep(road.y, road.y + 0.08, p.y));
	float slab = 1.0 - setts - asphalt;
	// Slabs are 4 x 3 m; each has its own texture offset and a slight tint.
	vec2 cell = floor(p / vec2(4.0, 3.0));
	vec2 local = p / vec2(4.0, 3.0) - cell;
	float id = hash(cell);
	vec2 slab_uv = p * 0.33 + vec2(hash(cell + 7.1), hash(cell + 3.3)) * 5.0;
	vec2 joint = min(local, 1.0 - local) * vec2(4.0, 3.0);
	float seam = 1.0 - smoothstep(0.012, 0.035, min(joint.x, joint.y));
	vec3 slab_c = texture(slab_color, slab_uv).rgb * mix(0.86, 1.08, id);
	slab_c = mix(slab_c, vec3(0.05, 0.06, 0.06), seam * 0.85);
	vec3 setts_c = texture(setts_color, p * 0.55).rgb * 0.92;
	vec3 asphalt_c = texture(asphalt_color, p * 0.4).rgb * 1.35;
	vec3 rough = texture(roughness_pack, slab_uv).rgb;
	float base_rough = rough.r * slab + texture(roughness_pack, p * 0.55).g * setts + texture(roughness_pack, p * 0.4).b * asphalt;
	vec3 n = texture(slab_normal, slab_uv).rgb * slab + texture(setts_normal, p * 0.55).rgb * setts + texture(asphalt_normal, p * 0.4).rgb * asphalt;
	n = mix(n, vec3(0.5, 0.5, 1.0), seam * 0.6);
	// Rain collects in broad low patches and fills the setts' joints and slab seams.
	float wet = smoothstep(0.42, 0.7, noise(p * 0.55) + noise(p * 1.7) * 0.15);
	float joints = setts * (1.0 - smoothstep(0.25, 0.45, texture(setts_color, p * 0.55).g * 1.6));
	wet = max(wet, max(seam * 0.9, joints * 0.7));
	vec3 albedo = slab_c * slab + setts_c * setts + asphalt_c * asphalt;
	ALBEDO = albedo * mix(vec3(0.72, 0.76, 0.77), vec3(0.24, 0.29, 0.31), wet);
	ROUGHNESS = mix(clamp(base_rough, 0.55, 0.95), 0.1, wet);
	METALLIC = wet * 0.2;
	NORMAL_MAP = mix(n, vec3(0.5, 0.5, 1.0), wet * 0.85);
	NORMAL_MAP_DEPTH = 0.9;
	SPECULAR = 0.6;
}

shader_type spatial;
// Kenney's flat palette, weathered for a storm harbour: desaturated, darkened
// toward the ground, and streaked by rust and rain run-off down vertical faces.
uniform sampler2D palette : source_color, filter_nearest;
uniform float desaturate = 0.55;
uniform vec3 tint : source_color = vec3(0.78, 0.82, 0.84);
varying vec3 world_pos;
varying vec3 world_normal;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void vertex(){
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	world_normal = normalize((MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz);
}
void fragment(){
	vec3 c = texture(palette, UV).rgb;
	float luma = dot(c, vec3(0.299, 0.587, 0.114));
	c = mix(c, vec3(luma), desaturate) * tint;
	// Grime pools near the ground and fades with height.
	float grime = mix(0.62, 1.0, smoothstep(0.0, 2.2, world_pos.y));
	// Vertical run-off streaks on walls only.
	float wall = 1.0 - abs(world_normal.y);
	float lane = floor((world_pos.x + world_pos.z) * 7.0);
	float streak = hash(vec2(lane, 3.7)) * smoothstep(0.0, 1.0, fract(world_pos.y * 0.35 + hash(vec2(lane, 9.1))));
	c *= grime * (1.0 - wall * streak * 0.22);
	c = mix(c, c * vec3(1.05, 0.82, 0.62), wall * step(0.86, hash(vec2(lane, 1.3))) * 0.5);
	ALBEDO = c;
	ROUGHNESS = mix(0.55, 0.85, luma);
	SPECULAR = 0.35;
}

shader_type spatial;
render_mode cull_disabled;
void vertex() {
 VERTEX.y += sin(VERTEX.x * 1.4 + TIME * 1.1) * 0.035 + cos(VERTEX.z * 1.8 - TIME * 1.4) * 0.025;
}
void fragment() {
 float ripple = sin(UV.x * 240.0 + TIME) * cos(UV.y * 220.0 - TIME * 1.2);
 ALBEDO = mix(vec3(0.035,0.13,0.17),vec3(0.13,0.31,0.34),ripple*0.5+0.5);
 ROUGHNESS = 0.24;
 METALLIC = 0.38;
 NORMAL_MAP = vec3(0.5+ripple*0.09,0.5+sin(UV.y*180.0+TIME)*0.07,1.0);
}

shader_type spatial;
render_mode cull_disabled;
varying vec3 world_point;
void vertex(){
 world_point=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;
 VERTEX.y+=sin(world_point.x*1.3+world_point.z*0.55+TIME*1.05)*0.045+sin(world_point.z*2.1-world_point.x*0.7-TIME*1.4)*0.023;
}
void fragment(){
 vec2 p=world_point.xz;
 float a=sin(p.x*1.3+p.y*0.55+TIME*1.05);
 float b=sin(p.y*2.1-p.x*0.7-TIME*1.4);
 float c=sin(p.x*5.3+p.y*3.7+TIME*2.2)*0.22;
 float fresnel=pow(1.0-clamp(dot(normalize(NORMAL),normalize(VIEW)),0.0,1.0),3.0);
 ALBEDO=mix(vec3(0.025,0.065,0.075),vec3(0.15,0.23,0.25),fresnel)* (0.92+(a+b)*0.04);
 ROUGHNESS=0.18;
 METALLIC=0.25;
 SPECULAR=0.8;
 NORMAL_MAP=normalize(vec3((a+c)*0.16,(b-c)*0.13,1.0))*0.5+0.5;
}

shader_type spatial;
uniform sampler2D concrete_color : source_color;
uniform sampler2D concrete_normal : hint_normal;
uniform sampler2D concrete_roughness;
varying vec3 world_point;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void vertex(){world_point=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;}
void fragment(){
 vec2 uv=world_point.xz*0.72;
 float wet=smoothstep(0.40,0.68,noise(world_point.xz*0.65)+noise(world_point.xz*1.8)*0.13);
 vec3 stone=texture(concrete_color,uv).rgb;
 ALBEDO=stone*mix(vec3(0.57,0.61,0.62),vec3(0.23,0.29,0.31),wet);
 ROUGHNESS=mix(clamp(texture(concrete_roughness,uv).r,0.65,0.95),0.13,wet);
 METALLIC=wet*0.25;
 NORMAL_MAP=mix(texture(concrete_normal,uv).rgb,vec3(0.5,0.5,1.0),wet*0.88);
 NORMAL_MAP_DEPTH=0.55;
 SPECULAR=0.65;
}

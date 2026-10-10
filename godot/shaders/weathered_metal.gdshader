shader_type spatial;
uniform sampler2D palette : source_color;
uniform sampler2D weathering : source_color;
varying vec3 world_point;
void vertex(){world_point=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;}
void fragment(){
 vec3 paint=texture(palette,UV).rgb;
 float grit=texture(weathering,vec2(world_point.x+world_point.z,world_point.y)*0.6).r;
 float streak=texture(weathering,vec2(world_point.x+world_point.z,world_point.y*0.08)*1.8).r;
 float base_stain=(1.0-smoothstep(0.0,1.4,world_point.y))*0.22;
 ALBEDO=paint*mix(vec3(0.49,0.55,0.57),vec3(0.89,0.90,0.85),grit)*(0.83+streak*0.17-base_stain);
 ROUGHNESS=0.57+grit*0.24;
 METALLIC=0.16;
}

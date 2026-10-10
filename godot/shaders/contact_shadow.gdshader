shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_never;
void fragment(){float edge=min(min(UV.x,1.0-UV.x),min(UV.y,1.0-UV.y));ALBEDO=vec3(0.015,0.023,0.027);ALPHA=smoothstep(0.0,0.20,edge)*0.46;}

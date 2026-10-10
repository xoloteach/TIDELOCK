shader_type sky;
// Photographed cloud band (Poly Haven, CC0) mapped from horizon to zenith and
// broken up by a procedural scud layer. The sky is static on purpose: a
// time-varying sky re-renders the radiance cubemap every frame.
uniform sampler2D clouds : source_color, filter_linear_mipmap, repeat_enable;
uniform float flash = 0.0;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void sky(){
 float height=max(EYEDIR.y,0.0);
 float u=atan(EYEDIR.x,-EYEDIR.z)/6.2831853+0.5;
 float v=1.0-asin(height)/1.5707963;
 vec3 photo=texture(clouds,vec2(u,clamp(v,0.0,0.995))).rgb;
 vec2 p=EYEDIR.xz/(height+0.28)*2.6;
 float scud=noise(p)*0.58+noise(p*2.1)*0.28+noise(p*4.3)*0.14;
 vec3 horizon=vec3(0.30,0.37,0.40);
 vec3 storm=photo*vec3(0.50,0.56,0.60)*mix(0.82,1.08,scud);
 COLOR=mix(horizon,storm,smoothstep(0.0,0.14,height));
 // Below the horizon the sea fog takes over.
 COLOR=mix(COLOR,vec3(0.22,0.29,0.31),smoothstep(0.0,-0.08,EYEDIR.y));
 COLOR+=vec3(0.12,0.08,0.04)*pow(max(dot(normalize(vec3(-0.7,0.14,-0.4)),EYEDIR),0.0),14.0);
 // Lightning lights the cloud base from within.
 COLOR+=flash*vec3(0.78,0.84,1.0)*(0.35+photo*0.9);
}

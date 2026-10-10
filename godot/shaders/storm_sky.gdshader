shader_type sky;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void sky(){
 float height=max(EYEDIR.y,0.0);
 vec2 p=EYEDIR.xz/(height+0.28)*2.6;
 float clouds=noise(p)*0.58+noise(p*2.1)*0.28+noise(p*4.3)*0.14;
 vec3 horizon=vec3(0.38,0.46,0.49);
 vec3 zenith=mix(vec3(0.12,0.18,0.23),vec3(0.30,0.35,0.37),smoothstep(0.32,0.72,clouds));
 COLOR=mix(horizon,zenith,smoothstep(0.0,0.65,height));
 COLOR+=vec3(0.18,0.12,0.055)*pow(max(dot(normalize(vec3(-0.7,0.14,-0.4)),EYEDIR),0.0),14.0);
}

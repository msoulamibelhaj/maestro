// shaders.js — vertex/fragment for techno points

export const particleVert = /* glsl */`
precision mediump float;
precision mediump int;

uniform float uTime;
uniform float uBass, uMid, uTreble;
uniform float uMusicReactivity, uTrebleSensitivity, uPulseIntensity;
uniform float uSphereRadius;

uniform vec3  uHandPos[2];
uniform float uHandVel[2];
uniform float uHandStrength, uHandReach, uFieldPower;
uniform float uVelStrength;

uniform float uKick;
uniform float uHandSpeed;
uniform vec3  uHandDir;

uniform vec3  uCamPos;
uniform float uPointMin, uPointMax;

uniform float uNoiseAmount;
uniform float uSwirlAmount;

uniform float uHueShift;
uniform float uColorMix;
uniform float uRimBoost;
uniform float uGlowGain;
uniform float uRippleAmt;

attribute vec3 aBase;
attribute float aShell; // 0 inner, 1 outer
attribute float aSeed;

varying float vAlpha;
varying float vFres;
varying float vShell;
varying float vHue;
varying float vDepthK;
varying float vSpark;

// simplex helpers
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx; vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z), y_=floor(j-7.0*x_); vec4 x=x_*ns.x+ns.yyyy, y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y); vec4 b0=vec4(x.xy,y.xy), b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0, s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x), p1=vec3(a0.zw,h.y), p2=vec3(a1.xy,h.z), p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

vec3 rotateAroundAxis(vec3 v, vec3 axis, float angle){
  vec3 a = normalize(axis);
  float s = sin(angle), c = cos(angle);
  return v*c + cross(a,v)*s + a*dot(a,v)*(1.0-c);
}

float hash11(float x){ return fract(sin(x*12.9898+78.233)*43758.5453); }

void main(){
  // base radius + breathing + kick
  float radius = uSphereRadius * mix(0.62, 1.0, aShell);
  float outerBreath = (uMid*0.05 + uTreble*0.07*uTrebleSensitivity) * uMusicReactivity * uPulseIntensity;
  float innerBreath = (uBass*0.10) * uMusicReactivity * uPulseIntensity;
  float breath = mix(innerBreath, outerBreath, aShell);
  float R = radius * (1.0 + breath);
  R *= (1.0 + uKick * 0.10 * (0.6 + 0.4*aShell));

  vec3 dirN  = normalize(aBase);
  vec3 baseP = dirN * R;

  // drift
  vec3 drift = uNoiseAmount * vec3(
    snoise(aBase*0.25 + vec3(0.0, uTime*0.2, 11.3)),
    snoise(aBase*0.25 + vec3(17.7, uTime*0.2, 0.0)),
    snoise(aBase*0.25 + vec3(0.0, uTime*0.2, 29.9))
  );

  vec3 posW = (modelMatrix * vec4(baseP, 1.0)).xyz + drift;

  // beat ripple
  float ripple = uRippleAmt * (0.15 + 0.85*aShell) * sin(
    dot(dirN, vec3(0.0,1.0,0.0)) * 18.0
    - uTime * (3.0 + 5.0*uKick)
    + aSeed * 4.0
  ) * (0.35*uKick + 0.15*(uBass+uMid+uTreble));
  posW += dirN * ripple;

  // hand fields
  for (int i=0; i<2; i++){
    vec3 hpos = uHandPos[i];
    vec3 to = posW - hpos;
    float d = length(to) + 1e-4;
    vec3 dir= to / d;

    float fallLin = 1.0 / (1.0 + d * uHandReach);
    float fall = pow(fallLin, uFieldPower);

    float vmag = clamp(uHandVel[i], 0.0, 1.0);
    vec3 velPush = normalize(uHandDir) * (uVelStrength * vmag * 0.4);
    posW += velPush * fall;

    posW += dir * fall * uHandStrength * 0.30;

    vec3 tangent = normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    posW += tangent * fall * uHandStrength * uSwirlAmount * 0.35;
  }

  float twist = uHandSpeed * 0.5 * (0.6 + 0.4*aShell);
  if (twist > 0.0) posW = rotateAroundAxis(posW, uHandDir, twist);

  vec4 mv = viewMatrix * vec4(posW, 1.0);
  vec3 viewDir = normalize(uCamPos - posW);
  vec3 surfN   = normalize(posW);
  float fres   = pow(max(0.0, 1.0 - dot(surfN, viewDir)), 1.6);
  float depthK = clamp((-mv.z - 20.0)/140.0, 0.0, 1.0);

  gl_Position = projectionMatrix * mv;

  // point size
  float baseSize = mix(uPointMin, uPointMax, aShell);
  float audioLift= (uBass + uMid + uTreble)*0.12 * uMusicReactivity;
  float speedLift= uHandSpeed*0.20 + uKick*0.15;
  float size = baseSize * (1.0 + audioLift + speedLift) * mix(1.0, 1.22, fres);
  gl_PointSize = size * (300.0 / -mv.z);

  // alpha
  float a = mix(0.45, 0.80, aShell);
  a *= mix(0.9, 1.1, fres);
  a *= mix(1.0, 0.8, depthK);
  vAlpha = clamp(a, 0.0, 0.9);

  // pass
  vFres   = fres;
  vShell  = aShell;
  vDepthK = depthK;

  float h = hash11(aSeed*91.7) * 2.0 - 1.0; // [-1..1]
  vHue = h*0.15 + uHueShift + 0.06*(uTreble*uMusicReactivity);
  vSpark = smoothstep(0.65, 1.0, hash11(aSeed*537.13 + floor(uTime*9.0))) 
           * (0.2 + 0.8*uTreble*uMusicReactivity);
}
`;

export const particleFrag = /* glsl */`
precision mediump float;
precision mediump int;

varying float vAlpha;
varying float vFres;
varying float vShell;
varying float vHue;
varying float vDepthK;
varying float vSpark;

uniform vec3 uColInner;
uniform vec3 uColOuter;
uniform vec3 uColRim;
uniform float uColorMix;
uniform float uRimBoost;
uniform float uGlowGain;

vec3 hueShift(vec3 c, float h){
  const mat3 toYIQ = mat3(
    0.299,     0.587,     0.114,
    0.595716, -0.274453, -0.321263,
    0.211456, -0.522591,  0.311135
  );
  const mat3 toRGB = inverse(toYIQ);
  vec3 yiq = toYIQ * c;
  float hue = atan(yiq.z, yiq.y) + h*6.2831853;
  float chroma = sqrt(yiq.y*yiq.y + yiq.z*yiq.z);
  yiq.y = chroma * cos(hue);
  yiq.z = chroma * sin(hue);
  return toRGB * yiq;
}

void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  float mask = 1.0 - smoothstep(0.49, 0.5, r);
  if (mask <= 0.0) discard;

  vec3 baseCol = mix(uColInner, uColOuter, vShell * uColorMix);
  baseCol = hueShift(baseCol, vHue);

  // depth tint
  vec3 depthTintNear = vec3(1.0, 0.98, 0.95);
  vec3 depthTintFar  = vec3(0.85, 0.90, 1.00);
  baseCol *= mix(depthTintNear, depthTintFar, vDepthK);

  // rim
  float rim = pow(vFres, 1.2);
  vec3 rimCol = hueShift(uColRim, vHue*0.5);
  vec3 col = baseCol + rimCol * rim * uRimBoost;

  // sparkles
  float core = smoothstep(0.0, 0.28, 0.28 - r);
  col += col * vSpark * core * 0.6;

  // center bloom bias
  float bloom = smoothstep(0.5, 0.0, r);
  col *= (1.0 + bloom * 0.35);

  float alpha = vAlpha * mask;

  // light dither to avoid banding at low alpha
  vec2 p = gl_FragCoord.xy;
  float d = fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453);
  alpha = clamp(alpha + (d - 0.5) * 0.015, 0.0, 1.0);

  if (alpha < 0.003) discard;
  gl_FragColor = vec4(col * uGlowGain, alpha);
}
`;

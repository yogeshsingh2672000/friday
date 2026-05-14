export default /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main(){
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.0, d);
  float glow = pow(core, 2.2);
  vec3 col = vColor * (0.6 + glow * 1.4);
  gl_FragColor = vec4(col, vAlpha * glow);
}
`;

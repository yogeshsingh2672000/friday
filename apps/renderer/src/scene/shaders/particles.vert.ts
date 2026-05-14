export default /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uMicLevel;
uniform float uTtsLevel;
uniform float uPhase;

attribute float aRandom;
attribute float aSpeed;
attribute vec3 aColor;

varying vec3 vColor;
varying float vAlpha;

void main(){
  float t = uTime * aSpeed * 0.3;
  vec3 p = position;
  float r = length(p) + sin(t + aRandom * 6.283) * 0.05;
  float orbit = t + aRandom * 6.283;
  float swirl = uPhase > 1.5 ? 1.4 : 0.6;

  vec3 displaced = vec3(
    r * cos(orbit * swirl + p.y * 0.5),
    p.y + sin(t * 0.5 + aRandom * 3.14) * 0.1,
    r * sin(orbit * swirl + p.y * 0.5)
  );

  vec4 world = modelMatrix * vec4(displaced, 1.0);
  vec4 view = viewMatrix * world;
  gl_Position = projectionMatrix * view;

  float energy = 1.0 + uTtsLevel * 3.0 + uMicLevel * 1.5;
  gl_PointSize = uSize * energy * (0.6 + aRandom * 0.5) * (220.0 / -view.z);

  vColor = aColor;
  vAlpha = 0.4 + 0.6 * abs(sin(t + aRandom * 6.0));
}
`;

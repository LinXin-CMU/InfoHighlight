// Colors follow dqy08/InfoLens, Apache-2.0; score transfer is local calibration.
// See UPSTREAM-NOTICE.md. Normalized demo scores are not real surprisal bits.
// BEGIN SHARED PAINT
const paintClamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
export const appearanceCurve = Object.freeze({x1:.25,y1:0,x2:.5,y2:1,saturation:.8,levels:16});
// Solve x(t)=score/cap, then read y(t). Using score directly as t is not a
// cubic-bezier transfer. Horizontal endpoint tangents also smooth the cap join.
export function scoreCurve(score) {
  const x=paintClamp(score,0,1)/appearanceCurve.saturation;
  if(x<=0)return 0;if(x>=1)return 1;
  const axis=(t,a,b)=>3*(1-t)*(1-t)*t*a+3*(1-t)*t*t*b+t*t*t;
  let low=0,high=1;
  for(let i=0;i<30;i++){const t=(low+high)/2;if(axis(t,appearanceCurve.x1,appearanceCurve.x2)<x)low=t;else high=t;}
  return axis((low+high)/2,appearanceCurve.y1,appearanceCurve.y2);
}
// Quantize AFTER the curve, so every client shares the same 16 paint levels.
export function displayLevel(score){return Math.round(scoreCurve(score)*(appearanceCurve.levels-1));}
export function appearanceAtLevel(level,intensity=1){
  const amount=paintClamp(level,0,15)/15,strength=paintClamp(intensity,0,1.5);
  const floor=.08-.05*Math.max(0,strength-1)*2;
  const normal=floor+(1-floor)*amount,visibility=normal+(1-normal)*(1-Math.min(1,strength));
  return {amount:amount*strength,backgroundOpacity:amount*Math.min(1,strength*.5),
    tintPercent:amount*Math.min(1,strength)*100,underlineOpacity:amount*Math.min(1,strength),fadePercent:visibility*100};
}
export function heatAppearance(score,intensity=1){return appearanceAtLevel(displayLevel(score),intensity);}
export function fadeVisibility(score,intensity=1){return heatAppearance(score,intensity).fadePercent/100;}
// END SHARED PAINT
// Every client card shows the same range, including the fully clear endpoint.
export const appearancePreviewSamples = Object.freeze([
  Object.freeze({text:'普通文字',score:0}),
  Object.freeze({text:'补充说明',score:.5}),
  Object.freeze({text:'关键结论',score:1})
]);
export function hueRgb(hue = 0) {
  const h = ((Number.isFinite(hue) ? hue : 0) % 360 + 360) % 360;
  if(h === 0)return [255,71,64];
  const chroma = 1 - Math.abs(2 * (319 / 510) - 1);
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = 319 / 510 - chroma / 2;
  const sectors = [[chroma,x,0],[x,chroma,0],[0,chroma,x],[0,x,chroma],[x,0,chroma],[chroma,0,x]];
  return sectors[Math.floor(h / 60)].map(c => Math.round((c + m) * 255));
}

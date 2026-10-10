export function satellite(lng: number, lat: number, halfLng: number, W = 460, H = 260) {
  const halfLat = halfLng * (H / W) * Math.cos((lat * Math.PI) / 180);
  const b = [lng - halfLng, lat - halfLat, lng + halfLng, lat + halfLat];
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${b.join(",")}&bboxSR=4326&imageSR=3857&size=${W},${H}&format=jpg&f=image`;
  const toPx = ([x, y]: number[]) => [((x - b[0]) / (b[2] - b[0])) * W, ((b[3] - y) / (b[3] - b[1])) * H];
  return { url, toPx, W, H };
}

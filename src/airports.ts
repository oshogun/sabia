import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
}

const AIRPORTS_PATH = path.join(process.cwd(), 'airports.json');
const AIRPORTS_URL  = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const INCLUDE_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport']);

let airports: Airport[] = [];

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { fields.push(current); current = ''; }
    else { current += ch; }
  }
  fields.push(current);
  return fields;
}

function download(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        download(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export function parseCSV(csv: string): Airport[] {
  const lines = csv.split('\n');
  const result: Airport[] = [];
  // CSV columns: id,ident,type,name,latitude_deg,longitude_deg,...,icao_code,iata_code,gps_code,...
  //              0   1    2    3    4             5                  12       13        14
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = parseCSVLine(line);
    if (!INCLUDE_TYPES.has(f[2])) continue;
    const lat = parseFloat(f[4]);
    const lon = parseFloat(f[5]);
    if (isNaN(lat) || isNaN(lon)) continue;
    const icao = (f[12] || f[14] || f[1] || '').trim().toUpperCase();
    if (icao.length !== 4 || !/^[A-Z0-9]{4}$/.test(icao)) continue;
    result.push({ icao, name: f[3] || icao, lat, lon });
  }
  return result;
}

export function setAirports(list: Airport[]): void {
  airports = list;
}

export async function initAirports(): Promise<void> {
  if (fs.existsSync(AIRPORTS_PATH)) {
    try {
      setAirports(JSON.parse(fs.readFileSync(AIRPORTS_PATH, 'utf8')) as Airport[]);
      console.log(`[Airports] Loaded ${airports.length} airports from cache`);
      return;
    } catch {
      // fall through to download
    }
  }

  console.log('[Airports] Downloading airport database from OurAirports...');
  try {
    const csv = await download(AIRPORTS_URL);
    setAirports(parseCSV(csv));
    fs.writeFileSync(AIRPORTS_PATH, JSON.stringify(airports));
    console.log(`[Airports] Cached ${airports.length} airports to airports.json`);
  } catch (err) {
    console.warn('[Airports] Download failed — ICAO lookup unavailable:', err);
    setAirports([]);
  }
}

export function findNearestAirport(lat: number, lon: number, maxNm = 10): { icao: string; name: string } | null {
  if (airports.length === 0) return null;
  let best: Airport | null = null;
  let bestDist = Infinity;
  for (const ap of airports) {
    const d = haversineNm(lat, lon, ap.lat, ap.lon);
    if (d < bestDist) { bestDist = d; best = ap; }
  }
  return best !== null && bestDist <= maxNm ? { icao: best.icao, name: best.name } : null;
}

// India's states and union territories, so a search for one finds its capital in India. Open-Meteo's
// place search lists towns, not states: "Goa" alone finds Goa in the Philippines first.

export interface IndiaRegion {
  // The state or union territory as Open-Meteo names it (its admin1).
  name: string
  // What to search for: the capital, or the nearest large city when the capital is new or small.
  capital: string
  // Other names people type for it.
  aliases?: string[]
}

export const INDIA_REGIONS: IndiaRegion[] = [
  { name: 'Andhra Pradesh', capital: 'Vijayawada', aliases: ['AP'] },
  { name: 'Arunachal Pradesh', capital: 'Itanagar', aliases: ['Arunachal'] },
  { name: 'Assam', capital: 'Guwahati' },
  { name: 'Bihar', capital: 'Patna' },
  { name: 'Chhattisgarh', capital: 'Raipur', aliases: ['Chattisgarh'] },
  { name: 'Goa', capital: 'Panjim', aliases: ['Panaji'] },
  { name: 'Gujarat', capital: 'Ahmedabad' },
  { name: 'Haryana', capital: 'Chandigarh' },
  { name: 'Himachal Pradesh', capital: 'Shimla', aliases: ['Himachal', 'HP'] },
  { name: 'Jharkhand', capital: 'Ranchi' },
  { name: 'Karnataka', capital: 'Bengaluru' },
  { name: 'Kerala', capital: 'Thiruvananthapuram' },
  { name: 'Madhya Pradesh', capital: 'Bhopal', aliases: ['MP'] },
  { name: 'Maharashtra', capital: 'Mumbai' },
  { name: 'Manipur', capital: 'Imphal' },
  { name: 'Meghalaya', capital: 'Shillong' },
  { name: 'Mizoram', capital: 'Aizawl' },
  { name: 'Nagaland', capital: 'Kohima' },
  { name: 'Odisha', capital: 'Bhubaneswar', aliases: ['Orissa'] },
  { name: 'Punjab', capital: 'Chandigarh' },
  { name: 'Rajasthan', capital: 'Jaipur' },
  { name: 'Sikkim', capital: 'Gangtok' },
  { name: 'Tamil Nadu', capital: 'Chennai', aliases: ['TN'] },
  { name: 'Telangana', capital: 'Hyderabad' },
  { name: 'Tripura', capital: 'Agartala' },
  { name: 'Uttar Pradesh', capital: 'Lucknow', aliases: ['UP'] },
  { name: 'Uttarakhand', capital: 'Dehradun', aliases: ['Uttaranchal'] },
  { name: 'West Bengal', capital: 'Kolkata', aliases: ['Bengal', 'WB'] },
  { name: 'Andaman and Nicobar', capital: 'Port Blair', aliases: ['Andaman', 'Andaman and Nicobar Islands', 'Andamans'] },
  { name: 'Chandigarh', capital: 'Chandigarh' },
  { name: 'Dadra and Nagar Haveli and Daman and Diu', capital: 'Daman', aliases: ['Dadra and Nagar Haveli', 'Daman and Diu'] },
  { name: 'Delhi', capital: 'New Delhi', aliases: ['NCT of Delhi', 'National Capital Territory'] },
  { name: 'Jammu and Kashmir', capital: 'Srinagar', aliases: ['J&K', 'JK', 'Kashmir'] },
  { name: 'Ladakh', capital: 'Leh' },
  { name: 'Lakshadweep', capital: 'Kavaratti' },
  { name: 'Puducherry', capital: 'Puducherry', aliases: ['Pondicherry', 'Pondy'] },
]

// Lower case, accents dropped, "&" read as "and", and only letters and digits kept.
function key(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')
}

const BY_KEY = new Map<string, IndiaRegion>()
for (const region of INDIA_REGIONS) {
  for (const name of [region.name, `${region.name} India`, ...(region.aliases ?? [])]) BY_KEY.set(key(name), region)
}

// The state or union territory a typed name means ("goa", "Tamil Nadu", "J&K"), or undefined.
// Two-letter abbreviations count only in capitals, so "up" or "mp" typed as words don't match.
export function indiaRegion(typed: string): IndiaRegion | undefined {
  const text = typed.trim()
  if (/^[A-Za-z]{2}$/.test(text) && text !== text.toUpperCase()) return undefined
  // A state name that is also its capital's name (Chandigarh, Puducherry, Delhi) is left to the town search.
  const region = BY_KEY.get(key(text))
  return region && key(region.capital) !== key(text) ? region : undefined
}

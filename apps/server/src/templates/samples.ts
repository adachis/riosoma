/**
 * Invented people for sample records.  Every template draws from the same list, so a name never
 * belongs to anyone real and the samples read like one small organization.
 */
export const PEOPLE = [
  'Amara Okafor',
  'Theo Lindqvist',
  'Priya Raman',
  'Mateo Alvarez',
  'Hana Sato',
  'Jonah Whitfield',
  'Leila Haddad',
  'Samir Patel',
  'Grace Mwangi',
  'Oliver Brandt',
  'Nadia Kowalski',
  'Felix Moreau',
  'Ines Carvalho',
  'Daniel Osei',
  'Rosa Delgado',
  'Wen Li',
  'Marcus Bell',
  'Sofia Rossi',
  'Kwame Mensah',
  'Elena Petrova',
  'Lucas Ferreira',
  'Aisha Rahman',
  'Noah Fischer',
  'Mei Chen',
  'Gabriel Duarte',
  'Yara Nasser',
  'Isaac Cohen',
  'Chloe Martin',
  'Arjun Mehta',
  'Zoe Anderson',
  'Tomas Novak',
  'Fatima Zahra',
  'Ethan Brooks',
  'Lina Johansson',
  'Omar Farouk',
  'Julia Schmidt',
  'Kenji Watanabe',
  'Maya Goldberg',
  'Diego Ramirez',
  'Ruth Adeyemi',
  'Hugo Lambert',
  'Anika Sharma',
  'Caleb Turner',
  'Beatriz Souza',
  'Ravi Iyer',
  'Freya Nilsen',
  'Samuel Asante',
  'Clara Weber',
  'Mohammed Saleh',
  'Ivy Nguyen',
  'Leo Castillo',
  'Nora Lindgren',
  'Kofi Boateng',
  'Paula Jimenez',
  'Henry Walsh',
  'Sana Qureshi',
  'Victor Dubois',
  'Emma Kuznetsova',
  'Tariq Aziz',
  'Lucy Harper',
] as const;

/** The name at `index`, going around the list as often as needed. */
export function person(index: number): string {
  return PEOPLE[index % PEOPLE.length]!;
}

/** `amara.okafor@team.example.com`: addresses on a domain reserved for examples. */
export function emailOf(name: string, domain = 'team.example.com'): string {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${domain}`;
}

/** `(555) 555-0142`: numbers in the range set aside for fiction. */
export function phoneOf(index: number): string {
  return `(555) 555-${String(100 + (index % 100)).padStart(4, '0')}`;
}

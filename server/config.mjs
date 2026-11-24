export const STOCKS = [
  { symbol: 'TCX', name: 'TradeCore Exchange', sector: 'Financial technology', base: 10000, color: '#137d68', initials: 'TC', allocation: 40 },
  { symbol: 'NOVA', name: 'Nova Energy', sector: 'Clean energy', base: 24500, color: '#6a57bb', initials: 'NE', allocation: 25 },
  { symbol: 'APEX', name: 'Apex Systems', sector: 'Technology', base: 7800, color: '#3577b1', initials: 'AS', allocation: 50 },
  { symbol: 'ORBT', name: 'Orbit Mobility', sector: 'Transportation', base: 16400, color: '#ad7131', initials: 'OM', allocation: 30 },
];
export const DEMO_USERS = [
  { name: 'Arav', email: 'arav@tradecore.test', initials: 'AR' },
  { name: 'Priya', email: 'priya@tradecore.test', initials: 'PR' },
  { name: 'Rohan', email: 'rohan@tradecore.test', initials: 'RO' },
  { name: 'Ananya', email: 'ananya@tradecore.test', initials: 'AN' },
];
// Intentionally public credentials for the named, shared demonstration accounts.
export const DEMO_PASSWORD = 'TradeCore123!';
export const INITIAL_CASH = 10000000; // paise: Rs 1,00,000
export const EXCHANGE_ID = process.env.TRADECORE_EXCHANGE_ID || 'tradecore-live-v1';

import api from '../utils/api';

export async function getCallsignQthHistory() {
  return api.get('/callsign-qth/history');
}

export async function getCallsignQthHistoryByCallsign(callsign) {
  return api.get(`/callsign-qth/history/${callsign}`);
}

export async function addCallsignQthRecord(callsign, qth) {
  return api.post('/callsign-qth/history', { callsign, qth });
}

export async function clearCallsignQthHistory() {
  return api.delete('/callsign-qth/history');
}
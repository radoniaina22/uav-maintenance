export type DroneStatus = 'operationnel' | 'maintenance' | 'immobilise' | 'retire';
export type BatteryStatus = 'en_service' | 'stock' | 'hors_service';
export type ReportType = 'technique' | 'incident';
export type Severity = 'mineur' | 'majeur' | 'critique';
export type ReportStatus = 'ouvert' | 'en_cours' | 'clos';
export type VisitType = 'systematique' | 'corrective' | 'autre';

export type Role = 'admin' | 'pilote';
export type FlightStatus = 'ouvert' | 'cloture';

export interface DronePort {
  id: string;
  name: string;
  code: string | null;
  region_id: number | null;
  district_id: number | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  notes: string | null;
}

export type PartStatus = 'stock' | 'monte' | 'quarantaine' | 'rebut';

export interface PartType {
  code: string;
  category: string;
  name: string;
  default_max_hours: number | null;
  /** Potentiel par défaut en cycles (1 cycle = 1 décollage + 1 atterrissage) */
  default_max_cycles: number | null;
  multi: boolean;
  sort: number;
  active: boolean;
}

export interface DroneSlot {
  model: string;
  code: string;
  zone: string;
  label: string;
  type_code: string;
  sort: number;
}

export interface PartRow {
  id: string;
  code: string;
  /** Ancien code (registre antérieur à l'application, ex. MOV000038) */
  legacy_code: string | null;
  type_code: string;
  serial_number: string | null;
  manufacturer: string | null;
  status: PartStatus;
  drone_port_id: string | null;
  initial_hours: number;
  max_hours: number | null;
  /** Cycles avant suivi / potentiel propre en cycles */
  initial_cycles: number;
  max_cycles: number | null;
  acquired_on: string | null;
  notes: string | null;
  created_at: string;
  category: string;
  type_name: string;
  multi: boolean;
  max_hours_effective: number | null;
  max_cycles_effective: number | null;
  drone_id: string | null;
  drone_code: string | null;
  slot: string | null;
  zone: string | null;
  installed_at: string | null;
  slot_label: string | null;
  drone_port_name: string | null;
  flight_count: number;
  total_hours: number;
  /** 1 vol effectué pendant le montage = 1 cycle */
  total_cycles: number;
  hours_pct: number | null;
  cycle_pct: number | null;
  /** Le plus élevé des pourcentages heures / cycles */
  potential_pct: number | null;
}

export interface PartEventRow {
  id: string;
  part_id: string;
  event_type: 'entree_stock' | 'montage' | 'demontage' | 'quarantaine' | 'remise_en_stock' | 'rebut' | 'transfert';
  at: string;
  drone_id: string | null;
  slot: string | null;
  from_port_id: string | null;
  to_port_id: string | null;
  reason: string | null;
  /** Opération reprise de l'ancien registre */
  imported: boolean;
  editor_name: string | null;
  created_at: string;
  part_code: string;
  part_legacy_code: string | null;
  /** Auteur : utilisateur de l'application, sinon éditeur de l'ancien registre */
  actor_name: string | null;
  type_code: string;
  type_name: string;
  drone_code: string | null;
  from_port_name: string | null;
  to_port_name: string | null;
}

export interface PartInstallationRow {
  id: string;
  part_id: string;
  drone_id: string;
  slot: string | null;
  zone: string;
  installed_at: string;
  removed_at: string | null;
  removal_reason: string | null;
  part_code: string;
  drone_code: string;
  slot_label: string | null;
  hours_on_drone: number;
}

export interface StockThreshold {
  drone_port_id: string;
  type_code: string;
  min_qty: number;
}

export interface MgRegion {
  id: number;
  name: string;
}

export interface MgDistrict {
  id: number;
  region_id: number;
  name: string;
}

export interface Profile {
  user_id: string;
  role: Role;
  pilot_id: string | null;
}

export interface AdminUserRow {
  user_id: string;
  email: string;
  role: Role | null;
  pilot_id: string | null;
  pilot_name: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  /** informations saisies dans le formulaire d'inscription */
  signup: SignupInfo | null;
}

export type WorkOrderStatus = 'ouvert' | 'en_cours' | 'termine' | 'cloture';
export type WorkOrderKind = 'visite' | 'corrective' | 'remplacement' | 'inspection' | 'autre';
export type WorkOrderPriority = 'normale' | 'haute' | 'urgente';
export interface WorkOrder {
  id: string; number: string; drone_id: string; drone_port_id: string | null; title: string;
  kind: WorkOrderKind; priority: WorkOrderPriority; status: WorkOrderStatus;
  description: string | null; work_done: string | null; due_date: string | null; hours_at_opening: number | null;
  opened_by: string | null; opened_by_name: string | null; opened_at: string;
  signed_by: string | null; signed_by_name: string | null; signed_at: string | null; updated_at: string;
}
export interface WorkOrderRow extends WorkOrder { drone_code: string; drone_port_name: string | null; link_count: number }
export interface WorkOrderLink { id: string; work_order_id: string; kind: 'visite' | 'rapport' | 'piece'; ref_id: string; created_at: string }

export interface SignupInfo {
  full_name: string;
  phone?: string | null;
  license_number?: string | null;
  requested_port_id?: string | null;
  requested_port_name?: string | null;
  message?: string | null;
}

/** pilote : commandant de bord ; copilote ; stagiaire : pilote en formation (facultatif, heures comptées à part) */
export type CrewRole = 'pilote' | 'copilote' | 'stagiaire';

export interface LogbookRow {
  id: string;
  pilot_id: string;
  flight_id: string;
  role: CrewRole;
  entry_date: string;
  takeoff_time: string;
  landing_time: string;
  duration_min: number;
  drone_code: string | null;
  drone_port_name: string | null;
  destination_name: string | null;
  flight_type: FlightType;
  created_at: string;
  pilot_name: string;
  cumulative_hours: number;
}

export interface Drone {
  id: string;
  drone_port_id: string | null;
  code: string;
  model: string;
  serial_number: string | null;
  initial_flight_minutes: number;
  visit_interval_hours: number;
  status: DroneStatus;
  notes: string | null;
}

export interface DroneStatusRow extends Drone {
  drone_port_name: string | null;
  flight_count: number;
  last_flight_date: string | null;
  total_hours: number;
  last_visit_hours: number | null;
  last_visit_date: string | null;
  open_reports: number;
  next_visit_hours: number;
  hours_to_next_visit: number;
}

export interface BatteryPack {
  id: string;
  pack_number: number;
  drone_port_id: string | null;
  status: BatteryStatus;
  notes: string | null;
}

export interface PackStatusRow extends BatteryPack {
  drone_port_name: string | null;
  battery_count: number;
  max_total_cycles: number | null;
  max_cycle_pct: number | null;
  min_health_pct: number | null;
  nominal_capacity_mah: number | null;
  real_capacity_mah: number | null;
  last_used_on: string | null;
}

export interface CapacityTest {
  id: string;
  battery_id: string;
  test_date: string;
  measured_mah: number;
  cycles_at_test: number | null;
  technician: string | null;
  notes: string | null;
  created_at: string;
}

export interface TransferRow {
  id: string;
  battery_id: string;
  pack_id: string | null;
  from_port_id: string | null;
  to_port_id: string | null;
  transfer_date: string;
  notes: string | null;
  created_at: string;
  from_port_name: string | null;
  to_port_name: string | null;
  serial_number: string | null;
  pack_number: number | null;
}

export interface Battery {
  id: string;
  drone_port_id: string | null;
  pack_id: string | null;
  position: 'A' | 'B' | null;
  serial_number: string | null;
  model: string;
  capacity_mah: number;
  initial_cycles: number;
  max_cycles: number;
  status: BatteryStatus;
  commissioned_on: string | null;
  notes: string | null;
}

export interface BatteryStatusRow extends Battery {
  pack_number: number | null;
  code: string | null;
  pack_status: BatteryStatus | null;
  drone_port_name: string | null;
  flight_cycles: number;
  total_cycles: number;
  remaining_cycles: number;
  cycle_pct: number;
  last_used_on: string | null;
  last_measured_mah: number | null;
  last_test_date: string | null;
  health_pct: number | null;
  test_count: number;
}

export interface Pilot {
  id: string;
  full_name: string;
  license_number: string | null;
  phone: string | null;
  active: boolean;
  drone_port_id: string | null;
  initial_flight_minutes: number;
  /** responsable maintenance : signe les ordres de travail de son drone port */
  maintenance_lead: boolean;
}

export interface PilotStatsRow extends Pilot {
  drone_port_name: string | null;
  flight_count: number;
  total_hours: number;
  pic_hours: number;
  copilot_hours: number;
  last_flight_date: string | null;
  open_flight_count: number;
  has_account: boolean;
  /** heures et vols en tant que pilote en formation (hors total) */
  trainee_hours: number;
  trainee_flight_count: number;
}

export interface HealthFacility {
  id: string;
  drone_port_id: string | null;
  name: string;
  code: string | null;
  category: 'CSB1' | 'CSB2';
  region_id: number | null;
  district_id: number | null;
  latitude: number | null;
  longitude: number | null;
  distance_km: number | null;
  active: boolean;
  notes: string | null;
}

export type FlightType = 'livraison' | 'controle';
export type Organization = 'UNFPA' | 'MINSAN' | 'AUTRE';
export type QrfCause = 'meteo' | 'technique' | 'autre';
export type QrfWeatherCondition = 'vent' | 'pluie' | 'orage' | 'visibilite' | 'turbulence';
export type QrfTechCondition = 'gps' | 'liaison' | 'batterie' | 'moteur' | 'vibrations' | 'capteurs' | 'largage';
export type QrfCondition = QrfWeatherCondition | QrfTechCondition | 'autre';

export interface Flight {
  id: string;
  drone_id: string;
  destination_id: string | null;
  flight_type: FlightType;
  organization: Organization;
  organization_other: string | null;
  distance_km: number | null;
  cruise_altitude_m: number | null;
  voltage_start_v: number | null;
  voltage_end_v: number | null;
  qrf: boolean;
  qrf_cause: QrfCause | null;
  qrf_conditions: QrfCondition[] | null;
  qrf_time: string | null;
  qrf_details: string | null;
  retry_of_flight_id: string | null;
  flight_date: string;
  takeoff_time: string;
  drop_time: string | null;
  landing_time: string;
  payload_kg: number | null;
  avg_wind_ms: number | null;
  wind_direction_deg: number | null;
  consumption_mah: number | null;
  battery_pack_id: string | null;
  battery_1_id: string | null;
  battery_2_id: string | null;
  observation: string | null;
  created_at: string;
  drone_port_id: string | null;
  status: FlightStatus;
  closed_at: string | null;
  closed_by: string | null;
}

export interface FlightRow extends Flight {
  duration_min: number;
  time_to_drop_min: number | null;
  time_to_qrf_min: number | null;
  retry_count: number;
  drone_code: string;
  drone_port_name: string | null;
  destination_name: string | null;
  destination_category: string | null;
  destination_distance_km: number | null;
  organization_label: string;
  cell_voltage_start: number | null;
  cell_voltage_end: number | null;
  pack_number: number | null;
  battery_1_code: string | null;
  battery_2_code: string | null;
  battery_1_serial: string | null;
  battery_2_serial: string | null;
  pack_capacity_mah: number;
  /** commandant de bord puis copilote */
  pilot_names: string | null;
  /** pilote en formation (facultatif) */
  trainee_name: string | null;
  report_count: number;
  open_report_count: number;
}

export interface FlightPilot {
  flight_id: string;
  pilot_id: string;
  role: CrewRole;
}

export interface TechnicalReport {
  id: string;
  flight_id: string;
  report_type: ReportType;
  severity: Severity;
  component: string | null;
  description: string;
  corrective_action: string | null;
  status: ReportStatus;
  resolved_on: string | null;
  /** pilote ayant clôturé le rapport (renseigné par la base) */
  resolved_by_name: string | null;
  created_at: string;
}

export interface ReportRow extends TechnicalReport {
  flight_date: string;
  drone_id: string;
  drone_port_id: string | null;
  flight_status: FlightStatus;
  flight_type: FlightType;
  drone_code: string;
  destination_name: string | null;
}

export interface MaintenanceVisit {
  id: string;
  drone_id: string;
  visit_type: VisitType;
  visit_date: string;
  hours_at_visit: number;
  technician: string | null;
  work_done: string | null;
  notes: string | null;
}

/** pilote : commandant de bord ; copilote ; rapports : pilote ayant traité et clôturé les comptes rendus */
export type CrmVisaKind = 'pilote' | 'copilote' | 'rapports';

/** Visa électronique du CRM */
export interface CrmSignature {
  id: string;
  flight_id: string;
  kind: CrmVisaKind;
  user_id: string | null;
  signer_name: string;
  signed_at: string;
}

/** Notification CRM : visa à signer (pilote, copilote, rapports) ou suivi des comptes rendus (administrateur) */
export interface CrmTask {
  flight_id: string;
  kind: CrmVisaKind | 'suivi';
  flight_date: string;
  takeoff_time: string;
  closed_at: string | null;
  flight_status: FlightStatus;
  drone_code: string;
  drone_port_name: string | null;
  destination_name: string | null;
  flight_seq: number;
  report_count: number;
  open_reports: number;
}

/** Plan de vol WindPath enregistré (bibliothèque par drone port et destination) */
export interface FlightPlan {
  id: string;
  drone_port_id: string;
  destination_id: string | null;
  name: string;
  file_name: string;
  content: string;
  waypoint_count: number | null;
  distance_km: number | null;
  notes: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Vol en cours partagé avec le drone port (position recalée WindPath, pas GPS) */
export interface LiveFlight {
  user_id: string;
  drone_id: string;
  drone_port_id: string;
  drone_code: string;
  pilot_name: string | null;
  status: 'sol' | 'vol' | 'arrive';
  lat: number | null;
  lon: number | null;
  altitude_m: number | null;
  heading_deg: number | null;
  ground_speed_ms: number | null;
  phase: string | null;
  next_label: string | null;
  next_eta: string | null;
  delay_s: number | null;
  takeoff_at: string | null;
  landing_eta: string | null;
  mission_name: string | null;
  /** [[lat, lon, altitude], ...] */
  route: [number, number, number | null][] | null;
  drop_index: number | null;
  updated_at: string;
}

/** Estimation WindPath retenue pour un vol (prévu), comparée au réel */
export interface FlightPlanEstimate {
  flight_id: string;
  plan_id: string | null;
  mission_name: string | null;
  waypoint_count: number | null;
  distance_km: number | null;
  takeoff_time: string | null;
  drop_time: string | null;
  landing_time: string | null;
  duration_min: number | null;
  consumption_mah: number | null;
  voltage_end_v: number | null;
  margin_pct: number | null;
  wind_ms: number | null;
  wind_direction_deg: number | null;
  max_wind_ms: number | null;
  max_gust_ms: number | null;
  payload_kg: number | null;
  capacity_mah: number | null;
  wind_checked_at: string | null;
  created_at: string;
}

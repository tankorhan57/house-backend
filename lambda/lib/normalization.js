// Biomarker name normalization map
// Key = canonical name, Value = list of aliases
const NORMALIZATION_MAP = {
  crp: ['CRP', 'C-Reactive Protein', 'C Reactive Protein', 'hsCRP', 'hs-CRP', 'High Sensitivity CRP'],
  vitamin_d: ['Vitamin D', '25-OH Vitamin D', '25(OH)D', 'Vitamin D3', '25-Hydroxyvitamin D', 'Calcidiol'],
  ldl_cholesterol: ['LDL', 'LDL-C', 'LDL Cholesterol', 'LDL-Cholesterol', 'Low Density Lipoprotein'],
  hdl_cholesterol: ['HDL', 'HDL-C', 'HDL Cholesterol', 'HDL-Cholesterol', 'High Density Lipoprotein'],
  total_cholesterol: ['Total Cholesterol', 'Cholesterol', 'CHOL'],
  triglycerides: ['Triglycerides', 'TG', 'TRIG', 'Trigs'],
  hemoglobin_a1c: ['HbA1c', 'A1C', 'Hemoglobin A1c', 'Glycated Hemoglobin', 'Glycohemoglobin', 'HbA1C'],
  glucose: ['Glucose', 'Blood Glucose', 'Fasting Glucose', 'GLU', 'Blood Sugar'],
  tsh: ['TSH', 'Thyroid Stimulating Hormone', 'Thyrotropin'],
  testosterone: ['Testosterone', 'Total Testosterone', 'Free Testosterone', 'TEST'],
  ferritin: ['Ferritin', 'Serum Ferritin'],
  hemoglobin: ['Hemoglobin', 'HGB', 'HB', 'Hgb'],
  white_blood_cells: ['WBC', 'White Blood Cells', 'White Blood Cell Count', 'Leukocytes'],
  red_blood_cells: ['RBC', 'Red Blood Cells', 'Red Blood Cell Count', 'Erythrocytes'],
  platelets: ['Platelets', 'PLT', 'Platelet Count', 'Thrombocytes'],
  creatinine: ['Creatinine', 'CREA', 'Serum Creatinine'],
  egfr: ['eGFR', 'GFR', 'Estimated GFR', 'Glomerular Filtration Rate'],
  alt: ['ALT', 'Alanine Aminotransferase', 'SGPT', 'Alanine Transaminase'],
  ast: ['AST', 'Aspartate Aminotransferase', 'SGOT', 'Aspartate Transaminase'],
  sodium: ['Sodium', 'Na', 'Na+', 'Serum Sodium'],
};

// Build reverse lookup: alias -> canonical key
const REVERSE_MAP = {};
for (const [canonical, aliases] of Object.entries(NORMALIZATION_MAP)) {
  for (const alias of aliases) {
    REVERSE_MAP[alias.toLowerCase()] = canonical;
  }
}

function normalizeBiomarker(name) {
  if (!name) return { canonical: null, recognized: false };

  const lower = name.toLowerCase().trim();
  const canonical = REVERSE_MAP[lower];

  if (canonical) {
    return { canonical, recognized: true };
  }

  // Not recognized — return raw name with flag
  return { canonical: name, recognized: false };
}

module.exports = { normalizeBiomarker, NORMALIZATION_MAP };

---
# Canonical data = a FHIR R4 Bundle. Each entry has a stable `id` that the report
# body links to via `[display](#id)`. Any plain markdown viewer shows the narrative;
# FHIR-aware systems ingest the front matter.
resourceType: Bundle
type: document
timestamp: 2026-07-02T15:40:00Z
entry:
  - id: patient
    resource:
      resourceType: Patient
      name: [{ use: official, family: Rivera, given: [Jordan, A] }]
      gender: male
      birthDate: 1984-03-22
      identifier:
        - { system: urn:oid:2.16.840.1.113883.19.5, type: MR, value: MR-00482173 }

  - id: allergy-penicillin
    resource:
      resourceType: AllergyIntolerance
      clinicalStatus: active
      type: allergy
      category: [medication]
      criticality: high
      code: { coding: [{ system: http://www.nlm.nih.gov/research/umls/rxnorm, code: "7980", display: Penicillin }] }
      reaction: [{ manifestation: [{ text: Hives }], severity: moderate }]

  - id: cond-dm2
    resource:
      resourceType: Condition
      clinicalStatus: active
      category: [problem-list-item]
      code: { coding: [{ system: http://hl7.org/fhir/sid/icd-10-cm, code: E11.9, display: "Type 2 diabetes mellitus without complications" }] }

  - id: cond-htn
    resource:
      resourceType: Condition
      clinicalStatus: active
      category: [problem-list-item]
      code: { coding: [{ system: http://hl7.org/fhir/sid/icd-10-cm, code: I10, display: "Essential (primary) hypertension" }] }

  - id: cond-lbp
    resource:
      resourceType: Condition
      clinicalStatus: active
      category: [encounter-diagnosis]
      onsetString: "3 days"
      code: { coding: [{ system: http://hl7.org/fhir/sid/icd-10-cm, code: M54.50, display: "Low back pain, unspecified" }] }

  # ---- Vitals (LOINC / UCUM) ----
  - id: vital-bp
    resource:
      resourceType: Observation
      status: final
      code: { coding: [{ system: http://loinc.org, code: 85354-9, display: Blood pressure }] }
      component:
        - { code: { coding: [{ system: http://loinc.org, code: 8480-6, display: Systolic }] }, valueQuantity: { value: 138, unit: mmHg, code: mm[Hg] } }
        - { code: { coding: [{ system: http://loinc.org, code: 8462-4, display: Diastolic }] }, valueQuantity: { value: 86, unit: mmHg, code: mm[Hg] } }
  - id: vital-hr
    resource: { resourceType: Observation, status: final, code: { coding: [{ system: http://loinc.org, code: 8867-4, display: Heart rate }] }, valueQuantity: { value: 78, unit: /min, code: /min } }
  - id: vital-temp
    resource: { resourceType: Observation, status: final, code: { coding: [{ system: http://loinc.org, code: 8310-5, display: Body temperature }] }, valueQuantity: { value: 98.4, unit: degF, code: "[degF]" } }
  - id: vital-spo2
    resource: { resourceType: Observation, status: final, code: { coding: [{ system: http://loinc.org, code: 59408-5, display: SpO2 }] }, valueQuantity: { value: 98, unit: "%", code: "%" } }
  - id: vital-ht
    resource: { resourceType: Observation, status: final, code: { coding: [{ system: http://loinc.org, code: 8302-2, display: Body height }] }, valueQuantity: { value: 180, unit: cm, code: cm } }
  - id: vital-wt
    resource: { resourceType: Observation, status: final, code: { coding: [{ system: http://loinc.org, code: 29463-7, display: Body weight }] }, valueQuantity: { value: 89.8, unit: kg, code: kg } }
  - id: vital-bmi
    resource: { resourceType: Observation, status: final, code: { coding: [{ system: http://loinc.org, code: 39156-5, display: BMI }] }, valueQuantity: { value: 27.6, unit: kg/m2, code: kg/m2 } }

  # ---- Current medications ----
  - id: med-metformin
    resource:
      resourceType: MedicationStatement
      status: active
      medicationCodeableConcept: { coding: [{ system: http://www.nlm.nih.gov/research/umls/rxnorm, code: "861007", display: "metformin 1000 MG oral tablet" }] }
      dosage: [{ text: "1000 mg by mouth twice daily", timing: { repeat: { frequency: 2, period: 1, periodUnit: d } } }]
      reasonReference: [cond-dm2]

  - id: med-lisinopril
    resource:
      resourceType: MedicationStatement
      status: active
      medicationCodeableConcept: { coding: [{ system: http://www.nlm.nih.gov/research/umls/rxnorm, code: "314077", display: "lisinopril 20 MG oral tablet" }] }
      dosage: [{ text: "20 mg by mouth once daily", timing: { repeat: { frequency: 1, period: 1, periodUnit: d } } }]
      reasonReference: [cond-htn]

  # ---- Plan: new controlled-substance prescription (DEA Schedule II) ----
  - id: rx-hydrocodone
    resource:
      resourceType: MedicationRequest
      status: active
      intent: order
      medicationCodeableConcept: { coding: [{ system: http://www.nlm.nih.gov/research/umls/rxnorm, code: "857002", display: "hydrocodone bitartrate 5 MG / acetaminophen 325 MG oral tablet" }] }
      note: [{ text: "DEA Schedule II controlled substance" }]
      substitution: { allowedBoolean: false }
      dosageInstruction: [{ text: "1 tablet by mouth every 6 hours as needed for pain", asNeededBoolean: true, maxDosePerPeriod: { numerator: { value: 4 }, denominator: { value: 1, unit: d, code: d } } }]
      dispenseRequest: { quantity: { value: 20, unit: tablet }, numberOfRepeatsAllowed: 0 }
      reasonReference: [cond-lbp]

  # ---- Plan: temporary dose reduction (2 weeks, then resume) ----
  - id: adj-lisinopril
    resource:
      resourceType: MedicationRequest
      status: active
      intent: order
      priorPrescription: med-lisinopril
      medicationCodeableConcept: { coding: [{ system: http://www.nlm.nih.gov/research/umls/rxnorm, code: "314076", display: "lisinopril 10 MG oral tablet" }] }
      dosageInstruction: [{ text: "Reduce to 10 mg once daily for 2 weeks, then resume 20 mg", timing: { repeat: { boundsDuration: { value: 2, unit: wk, code: wk } } } }]
      note: [{ text: "Temporary reduction; recheck BP at follow-up" }]

  # ---- Plan: work restriction ----
  - id: restriction-lifting
    resource:
      resourceType: ServiceRequest
      status: active
      intent: order
      code: { text: "Work restriction: no lifting greater than 10 lb" }
      occurrencePeriod: { start: 2026-07-02, end: 2026-07-16 }
      reasonReference: [cond-lbp]

  # ---- Plan: follow-up ----
  - id: followup
    resource:
      resourceType: Appointment
      status: proposed
      description: "Follow-up for low back pain and BP recheck"
      requestedPeriod: [{ start: 2026-07-16 }]
---

# Encounter Report — Occupational Health

**Patient:** [Jordan A. Rivera](#patient) &nbsp;·&nbsp; **DOB:** [1984-03-22](#patient) (42) &nbsp;·&nbsp; **MRN:** [MR-00482173](#patient)
**Date of service:** 2026-07-02

## Problem List (PMH)

- [Type 2 diabetes mellitus](#cond-dm2) — *E11.9*
- [Essential hypertension](#cond-htn) — *I10*

## Allergies

- [Penicillin](#allergy-penicillin) — hives (moderate), **high** criticality

## Current Medications

- [Metformin 1000 mg](#med-metformin) — twice daily (for diabetes)
- [Lisinopril 20 mg](#med-lisinopril) — once daily (for hypertension)

## Vitals

| Measure | Value |
|---|---|
| BP | [138 / 86 mmHg](#vital-bp) |
| Heart rate | [78 /min](#vital-hr) |
| Temp | [98.4 °F](#vital-temp) |
| SpO₂ | [98 %](#vital-spo2) |
| Height | [5'11" (180 cm)](#vital-ht) |
| Weight | [198 lb (89.8 kg)](#vital-wt) |
| BMI | [27.6](#vital-bmi) |

## Assessment

- **[Acute low back pain](#cond-lbp)** — *M54.50*, mechanical, onset ~3 days ago. No red-flag symptoms.

## Plan

1. **New prescription (controlled):** [Hydrocodone/acetaminophen 5/325 mg](#rx-hydrocodone) — 1 tablet by mouth every 6 hours as needed for pain. Dispense **#20, no refills**. *DEA Schedule II.*
2. **Medication adjustment:** [Reduce lisinopril to 10 mg daily for 2 weeks](#adj-lisinopril), then resume 20 mg; recheck BP at follow-up.
3. **Work restriction:** [No lifting greater than 10 lb](#restriction-lifting) through **2026-07-16**.
4. **Follow-up:** [Return in 2 weeks](#followup) (~2026-07-16) for back pain reassessment and BP recheck.

---

<sub>The clinical narrative above renders in any markdown viewer. Each bracketed value links to a
FHIR resource `id` in the front matter, so FHIR-aware systems can ingest the structured Bundle
while everyone else reads the report as-is.</sub>

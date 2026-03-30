const KPI_COMBINATIONS = [
  // P/E
  { kpiId: 2, reportType: "year", priceType: "mean" },
  { kpiId: 2, reportType: "year", priceType: "low" },
  { kpiId: 2, reportType: "year", priceType: "high" },
  { kpiId: 2, reportType: "r12", priceType: "mean" },
  { kpiId: 2, reportType: "r12", priceType: "low" },
  { kpiId: 2, reportType: "r12", priceType: "high" },
  // P/S
  { kpiId: 3, reportType: "year", priceType: "mean" },
  { kpiId: 3, reportType: "year", priceType: "low" },
  { kpiId: 3, reportType: "year", priceType: "high" },
  { kpiId: 3, reportType: "r12", priceType: "mean" },
  { kpiId: 3, reportType: "r12", priceType: "low" },
  { kpiId: 3, reportType: "r12", priceType: "high" },
  // P/B
  { kpiId: 4, reportType: "year", priceType: "mean" },
  { kpiId: 4, reportType: "year", priceType: "low" },
  { kpiId: 4, reportType: "year", priceType: "high" },
  { kpiId: 4, reportType: "r12", priceType: "mean" },
  { kpiId: 4, reportType: "r12", priceType: "low" },
  { kpiId: 4, reportType: "r12", priceType: "high" },
  // P/EBIT
  { kpiId: 75, reportType: "year", priceType: "mean" },
  { kpiId: 75, reportType: "year", priceType: "low" },
  { kpiId: 75, reportType: "year", priceType: "high" },
  { kpiId: 75, reportType: "r12", priceType: "mean" },
  { kpiId: 75, reportType: "r12", priceType: "low" },
  { kpiId: 75, reportType: "r12", priceType: "high" },
  // P/EBITDA
  { kpiId: 74, reportType: "year", priceType: "mean" },
  { kpiId: 74, reportType: "year", priceType: "low" },
  { kpiId: 74, reportType: "year", priceType: "high" },
  { kpiId: 74, reportType: "r12", priceType: "mean" },
  { kpiId: 74, reportType: "r12", priceType: "low" },
  { kpiId: 74, reportType: "r12", priceType: "high" },
  // P/FCF
  { kpiId: 76, reportType: "year", priceType: "mean" },
  { kpiId: 76, reportType: "year", priceType: "low" },
  { kpiId: 76, reportType: "year", priceType: "high" },
  { kpiId: 76, reportType: "r12", priceType: "mean" },
  { kpiId: 76, reportType: "r12", priceType: "low" },
  { kpiId: 76, reportType: "r12", priceType: "high" },
  // EV/E
  { kpiId: 12, reportType: "year", priceType: "mean" },
  { kpiId: 12, reportType: "year", priceType: "low" },
  { kpiId: 12, reportType: "year", priceType: "high" },
  { kpiId: 12, reportType: "r12", priceType: "mean" },
  { kpiId: 12, reportType: "r12", priceType: "low" },
  { kpiId: 12, reportType: "r12", priceType: "high" },
  // EV/S
  { kpiId: 15, reportType: "year", priceType: "mean" },
  { kpiId: 15, reportType: "year", priceType: "low" },
  { kpiId: 15, reportType: "year", priceType: "high" },
  { kpiId: 15, reportType: "r12", priceType: "mean" },
  { kpiId: 15, reportType: "r12", priceType: "low" },
  { kpiId: 15, reportType: "r12", priceType: "high" },
  // EV/EBIT
  { kpiId: 10, reportType: "year", priceType: "mean" },
  { kpiId: 10, reportType: "year", priceType: "low" },
  { kpiId: 10, reportType: "year", priceType: "high" },
  { kpiId: 10, reportType: "r12", priceType: "mean" },
  { kpiId: 10, reportType: "r12", priceType: "low" },
  { kpiId: 10, reportType: "r12", priceType: "high" },
  // EV/EBITDA
  { kpiId: 11, reportType: "year", priceType: "mean" },
  { kpiId: 11, reportType: "year", priceType: "low" },
  { kpiId: 11, reportType: "year", priceType: "high" },
  { kpiId: 11, reportType: "r12", priceType: "mean" },
  { kpiId: 11, reportType: "r12", priceType: "low" },
  { kpiId: 11, reportType: "r12", priceType: "high" },
  // EV/OP
  { kpiId: 78, reportType: "year", priceType: "mean" },
  { kpiId: 78, reportType: "year", priceType: "low" },
  { kpiId: 78, reportType: "year", priceType: "high" },
  { kpiId: 78, reportType: "r12", priceType: "mean" },
  { kpiId: 78, reportType: "r12", priceType: "low" },
  { kpiId: 78, reportType: "r12", priceType: "high" },
  // EV/FCF
  { kpiId: 13, reportType: "year", priceType: "mean" },
  { kpiId: 13, reportType: "year", priceType: "low" },
  { kpiId: 13, reportType: "year", priceType: "high" },
  { kpiId: 13, reportType: "r12", priceType: "mean" },
  { kpiId: 13, reportType: "r12", priceType: "low" },
  { kpiId: 13, reportType: "r12", priceType: "high" },
  // P/B/tang
  { kpiId: 18, reportType: "year", priceType: "mean" },
  { kpiId: 18, reportType: "year", priceType: "low" },
  { kpiId: 18, reportType: "year", priceType: "high" },
  { kpiId: 18, reportType: "r12", priceType: "mean" },
  { kpiId: 18, reportType: "r12", priceType: "low" },
  { kpiId: 18, reportType: "r12", priceType: "high" },
  // EBIT/EV
  { kpiId: 17, reportType: "year", priceType: "mean" },
  { kpiId: 17, reportType: "year", priceType: "low" },
  { kpiId: 17, reportType: "year", priceType: "high" },
  { kpiId: 17, reportType: "r12", priceType: "mean" },
  { kpiId: 17, reportType: "r12", priceType: "low" },
  { kpiId: 17, reportType: "r12", priceType: "high" },
  // BorsVarde
  { kpiId: 50, reportType: "year", priceType: "mean" },
  { kpiId: 50, reportType: "year", priceType: "low" },
  { kpiId: 50, reportType: "year", priceType: "high" },
  { kpiId: 50, reportType: "r12", priceType: "mean" },
  { kpiId: 50, reportType: "r12", priceType: "low" },
  { kpiId: 50, reportType: "r12", priceType: "high" },
  // EV
  { kpiId: 49, reportType: "year", priceType: "mean" },
  { kpiId: 49, reportType: "year", priceType: "low" },
  { kpiId: 49, reportType: "year", priceType: "high" },
  { kpiId: 49, reportType: "r12", priceType: "mean" },
  { kpiId: 49, reportType: "r12", priceType: "low" },
  { kpiId: 49, reportType: "r12", priceType: "high" },
  // Bruttomarginal
  { kpiId: 28, reportType: "year", priceType: "mean" },
  { kpiId: 28, reportType: "r12", priceType: "mean" },
  { kpiId: 28, reportType: "quarter", priceType: "mean" },
  // EBITDA Marginal
  { kpiId: 32, reportType: "year", priceType: "mean" },
  { kpiId: 32, reportType: "r12", priceType: "mean" },
  { kpiId: 32, reportType: "quarter", priceType: "mean" },
  // Rorelsemarginal
  { kpiId: 29, reportType: "year", priceType: "mean" },
  { kpiId: 29, reportType: "r12", priceType: "mean" },
  { kpiId: 29, reportType: "quarter", priceType: "mean" },
  // Vinstmarginal
  { kpiId: 30, reportType: "year", priceType: "mean" },
  { kpiId: 30, reportType: "r12", priceType: "mean" },
  { kpiId: 30, reportType: "quarter", priceType: "mean" },
  // OperativtKassaflodesMarginal
  { kpiId: 51, reportType: "year", priceType: "mean" },
  { kpiId: 51, reportType: "r12", priceType: "mean" },
  { kpiId: 51, reportType: "quarter", priceType: "mean" },
  // FCF Marginal
  { kpiId: 31, reportType: "year", priceType: "mean" },
  { kpiId: 31, reportType: "r12", priceType: "mean" },
  { kpiId: 31, reportType: "quarter", priceType: "mean" },
  // ROE
  { kpiId: 33, reportType: "year", priceType: "mean" },
  { kpiId: 33, reportType: "r12", priceType: "mean" },
  // ROA
  { kpiId: 34, reportType: "year", priceType: "mean" },
  { kpiId: 34, reportType: "r12", priceType: "mean" },
  // ROA ex Goodwill
  { kpiId: 35, reportType: "year", priceType: "mean" },
  { kpiId: 35, reportType: "r12", priceType: "mean" },
  // ROIC
  { kpiId: 37, reportType: "year", priceType: "mean" },
  { kpiId: 37, reportType: "r12", priceType: "mean" },
  // ROC
  { kpiId: 36, reportType: "year", priceType: "mean" },
  { kpiId: 36, reportType: "r12", priceType: "mean" },
  // Omsattningshastighet
  { kpiId: 38, reportType: "year", priceType: "mean" },
  { kpiId: 38, reportType: "r12", priceType: "mean" },
  // Soliditet
  { kpiId: 39, reportType: "year", priceType: "mean" },
  { kpiId: 39, reportType: "r12", priceType: "mean" },
  // Skuldsattningsgrad
  { kpiId: 40, reportType: "year", priceType: "mean" },
  { kpiId: 40, reportType: "r12", priceType: "mean" },
  // Balanslikviditet
  { kpiId: 44, reportType: "year", priceType: "mean" },
  { kpiId: 44, reportType: "r12", priceType: "mean" },
  // Nettoskuldsattning
  { kpiId: 41, reportType: "year", priceType: "mean" },
  { kpiId: 41, reportType: "r12", priceType: "mean" },
  // Nettoskuld/EBITDA
  { kpiId: 42, reportType: "year", priceType: "mean" },
  { kpiId: 42, reportType: "r12", priceType: "mean" },
  // Rorelsekapital/LangfristigaSkulder
  { kpiId: 45, reportType: "year", priceType: "mean" },
  { kpiId: 45, reportType: "r12", priceType: "mean" },
  // RorelsekapitalProc
  { kpiId: 93, reportType: "year", priceType: "mean" },
  { kpiId: 93, reportType: "r12", priceType: "mean" },
  // ImmateriellaTillgangarProc
  { kpiId: 92, reportType: "year", priceType: "mean" },
  { kpiId: 92, reportType: "r12", priceType: "mean" },
  // Kassa
  { kpiId: 46, reportType: "year", priceType: "mean" },
  { kpiId: 46, reportType: "r12", priceType: "mean" },
  // Capex
  { kpiId: 25, reportType: "year", priceType: "mean" },
  { kpiId: 25, reportType: "r12", priceType: "mean" },
  { kpiId: 25, reportType: "quarter", priceType: "mean" },
  // Utdelning/FCF
  { kpiId: 26, reportType: "year", priceType: "mean" },
  { kpiId: 26, reportType: "r12", priceType: "mean" },
  // Vinst/FCF
  { kpiId: 27, reportType: "year", priceType: "mean" },
  { kpiId: 27, reportType: "r12", priceType: "mean" },
  { kpiId: 27, reportType: "quarter", priceType: "mean" },
  // Omsattning
  { kpiId: 53, reportType: "year", priceType: "mean" },
  { kpiId: 53, reportType: "r12", priceType: "mean" },
  { kpiId: 53, reportType: "quarter", priceType: "mean" },
  // Bruttoresultat
  { kpiId: 135, reportType: "year", priceType: "mean" },
  { kpiId: 135, reportType: "r12", priceType: "mean" },
  { kpiId: 135, reportType: "quarter", priceType: "mean" },
  // EBITDA
  { kpiId: 54, reportType: "year", priceType: "mean" },
  { kpiId: 54, reportType: "r12", priceType: "mean" },
  { kpiId: 54, reportType: "quarter", priceType: "mean" },
  // Rorelseresultat
  { kpiId: 55, reportType: "year", priceType: "mean" },
  { kpiId: 55, reportType: "r12", priceType: "mean" },
  { kpiId: 55, reportType: "quarter", priceType: "mean" },
  // VinstForeSkatt
  { kpiId: 125, reportType: "year", priceType: "mean" },
  { kpiId: 125, reportType: "r12", priceType: "mean" },
  { kpiId: 125, reportType: "quarter", priceType: "mean" },
  // Vinst
  { kpiId: 56, reportType: "year", priceType: "mean" },
  { kpiId: 56, reportType: "r12", priceType: "mean" },
  { kpiId: 56, reportType: "quarter", priceType: "mean" },
  // ImmateriellaTillgangar
  { kpiId: 126, reportType: "year", priceType: "mean" },
  { kpiId: 126, reportType: "r12", priceType: "mean" },
  // MateriellaTillgangar
  { kpiId: 127, reportType: "year", priceType: "mean" },
  { kpiId: 127, reportType: "r12", priceType: "mean" },
  // AnlaggningsTillgangar
  { kpiId: 129, reportType: "year", priceType: "mean" },
  { kpiId: 129, reportType: "r12", priceType: "mean" },
  // Omsattningstillgangar
  { kpiId: 131, reportType: "year", priceType: "mean" },
  { kpiId: 131, reportType: "r12", priceType: "mean" },
  // KassaLikvidaMedel
  { kpiId: 130, reportType: "year", priceType: "mean" },
  { kpiId: 130, reportType: "r12", priceType: "mean" },
  // TotalaTillgangar
  { kpiId: 57, reportType: "year", priceType: "mean" },
  { kpiId: 57, reportType: "r12", priceType: "mean" },
  // EgetKapital
  { kpiId: 58, reportType: "year", priceType: "mean" },
  { kpiId: 58, reportType: "r12", priceType: "mean" },
  // LangfristigaSkulder
  { kpiId: 132, reportType: "year", priceType: "mean" },
  { kpiId: 132, reportType: "r12", priceType: "mean" },
  // KortfristigaSkulder
  { kpiId: 133, reportType: "year", priceType: "mean" },
  { kpiId: 133, reportType: "r12", priceType: "mean" },
  // TotalaSkulder
  { kpiId: 137, reportType: "year", priceType: "mean" },
  { kpiId: 137, reportType: "r12", priceType: "mean" },
  // Nettoskuld
  { kpiId: 60, reportType: "year", priceType: "mean" },
  { kpiId: 60, reportType: "r12", priceType: "mean" },
  // TotalaSkulderOchEgetKapital
  { kpiId: 134, reportType: "year", priceType: "mean" },
  { kpiId: 134, reportType: "r12", priceType: "mean" },
  // OperativKassaflode
  { kpiId: 62, reportType: "year", priceType: "mean" },
  { kpiId: 62, reportType: "r12", priceType: "mean" },
  { kpiId: 62, reportType: "quarter", priceType: "mean" },
  // Capex M
  { kpiId: 64, reportType: "year", priceType: "mean" },
  { kpiId: 64, reportType: "r12", priceType: "mean" },
  { kpiId: 64, reportType: "quarter", priceType: "mean" },
  // KassaflodeFinansiering
  { kpiId: 138, reportType: "year", priceType: "mean" },
  { kpiId: 138, reportType: "r12", priceType: "mean" },
  { kpiId: 138, reportType: "quarter", priceType: "mean" },
  // AretsKassaflode
  { kpiId: 65, reportType: "year", priceType: "mean" },
  { kpiId: 65, reportType: "r12", priceType: "mean" },
  { kpiId: 65, reportType: "quarter", priceType: "mean" },
  // FrittKassaflode
  { kpiId: 63, reportType: "year", priceType: "mean" },
  { kpiId: 63, reportType: "r12", priceType: "mean" },
  { kpiId: 63, reportType: "quarter", priceType: "mean" },
  // AntalAktier
  { kpiId: 61, reportType: "year", priceType: "mean" },
  { kpiId: 61, reportType: "r12", priceType: "mean" },
  // Utdelning/Aktie
  { kpiId: 7, reportType: "year", priceType: "mean" },
  { kpiId: 7, reportType: "r12", priceType: "mean" },
  // Direktavkastning
  { kpiId: 1, reportType: "year", priceType: "mean" },
  { kpiId: 1, reportType: "year", priceType: "low" },
  { kpiId: 1, reportType: "year", priceType: "high" },
  { kpiId: 1, reportType: "r12", priceType: "mean" },
  { kpiId: 1, reportType: "r12", priceType: "low" },
  { kpiId: 1, reportType: "r12", priceType: "high" },
  // OrdinarDirektavkastning
  { kpiId: 148, reportType: "year", priceType: "mean" },
  { kpiId: 148, reportType: "year", priceType: "low" },
  { kpiId: 148, reportType: "year", priceType: "high" },
  { kpiId: 148, reportType: "r12", priceType: "mean" },
  { kpiId: 148, reportType: "r12", priceType: "low" },
  { kpiId: 148, reportType: "r12", priceType: "high" },
  // OrdinarUtdelning
  { kpiId: 66, reportType: "year", priceType: "mean" },
  { kpiId: 66, reportType: "r12", priceType: "mean" },
  // Utdelningsandel
  { kpiId: 20, reportType: "year", priceType: "mean" },
  { kpiId: 20, reportType: "r12", priceType: "mean" },
  // Vinsttillvaxt
  { kpiId: 97, reportType: "year", priceType: "mean" },
  { kpiId: 97, reportType: "r12", priceType: "mean" },
  { kpiId: 97, reportType: "quarter", priceType: "mean" },
  // EBITTillvaxt
  { kpiId: 96, reportType: "year", priceType: "mean" },
  { kpiId: 96, reportType: "r12", priceType: "mean" },
  { kpiId: 96, reportType: "quarter", priceType: "mean" },
  // Omsattningstillvaxt
  { kpiId: 94, reportType: "year", priceType: "mean" },
  { kpiId: 94, reportType: "r12", priceType: "mean" },
  { kpiId: 94, reportType: "quarter", priceType: "mean" },
  // EgetKapitalTillvaxt
  { kpiId: 99, reportType: "year", priceType: "mean" },
  { kpiId: 99, reportType: "r12", priceType: "mean" },
  // TotalaTillgangarTillvaxt
  { kpiId: 100, reportType: "year", priceType: "mean" },
  { kpiId: 100, reportType: "r12", priceType: "mean" },
  // P/EX
  { kpiId: 9, reportType: "year", priceType: "mean" },
  { kpiId: 9, reportType: "year", priceType: "low" },
  { kpiId: 9, reportType: "year", priceType: "high" },
  { kpiId: 9, reportType: "r12", priceType: "mean" },
  { kpiId: 9, reportType: "r12", priceType: "low" },
  { kpiId: 9, reportType: "r12", priceType: "high" },
  // PEG
  { kpiId: 19, reportType: "year", priceType: "mean" },
  { kpiId: 19, reportType: "year", priceType: "low" },
  { kpiId: 19, reportType: "year", priceType: "high" },
  { kpiId: 19, reportType: "r12", priceType: "mean" },
  { kpiId: 19, reportType: "r12", priceType: "low" },
  { kpiId: 19, reportType: "r12", priceType: "high" },
  // Utdelningstillvaxt
  { kpiId: 98, reportType: "year", priceType: "mean" },
  { kpiId: 98, reportType: "r12", priceType: "mean" },
  // Omsattning/Aktie
  { kpiId: 5, reportType: "year", priceType: "mean" },
  { kpiId: 5, reportType: "r12", priceType: "mean" },
  { kpiId: 5, reportType: "quarter", priceType: "mean" },
  // Vinst/Aktie
  { kpiId: 6, reportType: "year", priceType: "mean" },
  { kpiId: 6, reportType: "r12", priceType: "mean" },
  { kpiId: 6, reportType: "quarter", priceType: "mean" },
  // EgetKapital/Aktie
  { kpiId: 8, reportType: "year", priceType: "mean" },
  { kpiId: 8, reportType: "r12", priceType: "mean" },
  { kpiId: 8, reportType: "quarter", priceType: "mean" },
  // FCF/Aktie
  { kpiId: 23, reportType: "year", priceType: "mean" },
  { kpiId: 23, reportType: "r12", priceType: "mean" },
  { kpiId: 23, reportType: "quarter", priceType: "mean" },
  // Nettoskuld/Aktie
  { kpiId: 73, reportType: "year", priceType: "mean" },
  { kpiId: 73, reportType: "r12", priceType: "mean" },
  // EBITDA/Aktie
  { kpiId: 71, reportType: "year", priceType: "mean" },
  { kpiId: 71, reportType: "r12", priceType: "mean" },
  { kpiId: 71, reportType: "quarter", priceType: "mean" },
  // EBIT/Aktie
  { kpiId: 70, reportType: "year", priceType: "mean" },
  { kpiId: 70, reportType: "r12", priceType: "mean" },
  { kpiId: 70, reportType: "quarter", priceType: "mean" },
  // OperativKassaflode/Aktie
  { kpiId: 68, reportType: "year", priceType: "mean" },
  { kpiId: 68, reportType: "r12", priceType: "mean" },
  { kpiId: 68, reportType: "quarter", priceType: "mean" },
  // AretsKassaflode/Aktie
  { kpiId: 69, reportType: "year", priceType: "mean" },
  { kpiId: 69, reportType: "r12", priceType: "mean" },
  { kpiId: 69, reportType: "quarter", priceType: "mean" },
  // FinansiellaTillgangar
  { kpiId: 128, reportType: "year", priceType: "mean" },
  { kpiId: 128, reportType: "r12", priceType: "mean" },
  // AretsKassaflodeMarginal
  { kpiId: 140, reportType: "year", priceType: "mean" },
  { kpiId: 140, reportType: "r12", priceType: "mean" },
  { kpiId: 140, reportType: "quarter", priceType: "mean" },
  // FCF/Proc
  { kpiId: 24, reportType: "year", priceType: "mean" },
  { kpiId: 24, reportType: "r12", priceType: "mean" },
  { kpiId: 24, reportType: "quarter", priceType: "mean" },
  // E/EV
  { kpiId: 16, reportType: "year", priceType: "mean" },
  { kpiId: 16, reportType: "year", priceType: "low" },
  { kpiId: 16, reportType: "year", priceType: "high" },
  { kpiId: 16, reportType: "r12", priceType: "mean" },
  { kpiId: 16, reportType: "r12", priceType: "low" },
  { kpiId: 16, reportType: "r12", priceType: "high" },
  // TotalDirektavkastning
  { kpiId: 22, reportType: "year", priceType: "mean" },
];

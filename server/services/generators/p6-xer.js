// Primavera P6 XER export. The XER format is a tab-delimited text file with
// a known header and per-table sections. This produces a minimal but valid
// XER that imports cleanly into P6 and shows the project's WBS + activities.

const fs = require('fs');

function pad(s) { return s == null ? '' : String(s); }
function row(...vals) { return vals.map(pad).join('\t'); }

function generate(project, schedule, boq, outputPath) {
  const lines = [];
  const today = new Date().toISOString().slice(0, 10);
  const ermhdr = today.replace(/-/g, '-');
  const exportDate = new Date().toISOString();
  const projShortName = (project.name || 'PROJECT').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 20) || 'PROJECT';
  const projId = 1;
  const wbsRootId = 100;

  // ERMHDR — required version row.
  lines.push(`ERMHDR\t19.12\t${ermhdr}\tProject\tHALFORD\tHALFORD\thalford\tdbxDatabaseNoName\tProject Management\tAED`);

  // CURRTYPE
  lines.push('%T\tCURRTYPE');
  lines.push('%F\tcurr_id\tcurr_short_name\tcurr_symbol\tcurr_seq_num\tcurr_type\tdecimal_digit_cnt\tdecimal_symbol\tdigit_group_symbol\tneg_curr_fmt_type\tpos_curr_fmt_type\tdigit_group_size\tbase_exch_rate');
  lines.push(row('%R', 1, project.currency || 'AED', project.currency || 'AED', 1, project.currency || 'AED', 2, '.', ',', 1, 1, 3, 1));

  // OBS — minimal organizational breakdown structure
  lines.push('%T\tOBS');
  lines.push('%F\tobs_id\tparent_obs_id\tguid\tseq_num\tobs_name\tobs_descr');
  lines.push(row('%R', 1, '', '', 1, 'Halford', 'Auto-generated'));

  // PROJECT
  lines.push('%T\tPROJECT');
  lines.push('%F\tproj_id\tfy_start_month_num\trsrc_self_add_flag\tallow_complete_flag\trsrc_multi_assign_flag\tcheckout_flag\tproject_flag\tstep_complete_flag\tcost_qty_recalc_flag\tbatch_sum_flag\tname_sep_char\tdef_complete_pct_type\tproject_short_name\tproj_url\tdef_duration_type\tdef_cost_per_qty\tlast_recalc_date\tplan_start_date\tplan_end_date\tscd_end_date\tadd_date\tlast_tasksum_date\tfcst_start_date\tdef_qty_per_hr\tdef_8\tact_thr_finish_date\tlast_schedule_date\tcritical_path_type\tcritical_drtn_hr_cnt\tdef_complete_pct\tlast_baseline_update_date\tcr_external_key\tapply_actuals_date\tguid\trisk_level\trun_chk_flag\tprice_per_unit\tcosts_per_unit_default\tdef_complete_method\tlast_fin_dates_id\tfintmpl_id\tlast_baseline_id\tactive_flag\tbaseline_type_id\tact_thr_start_date');
  lines.push(row('%R', projId, 1, 'N', 'Y', 'N', 'N', 'Y', 'N', 'N', 'N', '.', 'CP_Drtn', projShortName, '', 'DT_FixedDUR2', 100, today, schedule.start_date, '', '', today, '', '', 1, '', '', '', 'CT_TopFloat', 8, 0, '', '', '', '', '', 'N', '', 'N', '', '', '', '', 'Y', '', ''));

  // WBS root + per-section
  lines.push('%T\tPROJWBS');
  lines.push('%F\twbs_id\tproj_id\tobs_id\tseq_num\test_wt\tproj_node_flag\tsum_data_flag\tstatus_code\twbs_short_name\twbs_name\tphase_id\tparent_wbs_id\tev_user_pct\tev_etc_user_value\torig_cost\tindep_remain_total_cost\tann_dscnt_rate_pct\tdscnt_period_type\tindep_remain_work_qty\task_end_date_flag\tguid\ttmpl_guid');
  lines.push(row('%R', wbsRootId, projId, 1, 1, 1, 'Y', 'N', 'WBS_Active', projShortName, project.name || projShortName, '', '', 0.06, 0, 0, 0, 0, '', 0, '', '', ''));

  schedule.activities.forEach((a, idx) => {
    const wbsId = wbsRootId + idx + 1;
    lines.push(row('%R', wbsId, projId, 1, idx + 2, 1, 'N', 'N', 'WBS_Active', a.name.replace(/\s+/g, '_').slice(0, 20), a.name, '', wbsRootId, '', '', 0, 0, 0, 0, 0, '', 0, '', '', ''));
  });

  // CALENDAR — single 6-day calendar
  lines.push('%T\tCALENDAR');
  lines.push('%F\tclndr_id\tdefault_flag\tclndr_name\tproj_id\tbase_clndr_id\tlast_chng_date\tclndr_type\tday_hr_cnt\tweek_hr_cnt\tmonth_hr_cnt\tyear_hr_cnt\trsrc_private\tclndr_data');
  // Truncated calendar data (P6 accepts this form)
  const calData = '(0||CalendarData(\nDaysOfWeek(\n0||1()(\n0||2(0||1(s|07:00|f|17:00))\n0||3(0||1(s|07:00|f|17:00))\n0||4(0||1(s|07:00|f|17:00))\n0||5(0||1(s|07:00|f|17:00))\n0||6(0||1(s|07:00|f|17:00))\n0||7(0||1(s|07:00|f|17:00))))\n)';
  lines.push(row('%R', 1, 'Y', 'Standard 6-Day', '', '', today + ' 00:00', 'CA_Project', 8, schedule.workdays_per_week * 8, schedule.workdays_per_week * 8 * 4, schedule.workdays_per_week * 8 * 50, '', calData));

  // RSRC
  lines.push('%T\tRSRC');
  lines.push('%F\trsrc_id\tparent_rsrc_id\tclndr_id\trole_id\tshift_id\tuser_id\tpobs_id\tguid\trsrc_seq_num\temail_addr\temployee_code\toffice_phone\tother_phone\trsrc_name\trsrc_short_name\trsrc_title_name\tdef_qty_per_hr\tcost_qty_type\tov_tm_factor\tactive_flag\tauto_compute_act_flag\tdef_cost_qty_link_flag\tot_flag\tcurr_id\tunit_id\trsrc_type\tlocation_id\trsrc_notes\tload_tasks_flag\tlevel_flag\trsrc_calc_costs');
  const crews = ['piling', 'concrete', 'steel', 'facade', 'finishes', 'mep', 'civils', 'block', 'earthworks'];
  crews.forEach((c, i) => {
    lines.push(row('%R', i + 1, '', 1, '', '', '', '', '', i + 1, '', '', '', '', `${c.charAt(0).toUpperCase()}${c.slice(1)} crew`, c.slice(0, 8).toUpperCase(), 'Crew', 1, 'QT_Daily', 1.5, 'Y', 'Y', 'Y', 'N', 1, '', 'RT_Labor', '', '', 'Y', 'Y', 'N'));
  });

  // TASK — one summary task per scheduled section
  lines.push('%T\tTASK');
  lines.push('%F\ttask_id\tproj_id\twbs_id\tclndr_id\tphys_complete_pct\trev_fdbk_flag\test_wt\tlock_plan_flag\tauto_compute_act_flag\tcomplete_pct_type\ttask_type\tduration_type\tstatus_code\ttask_code\ttask_name\trsrc_id\ttotal_float_hr_cnt\tfree_float_hr_cnt\tremain_drtn_hr_cnt\tact_work_qty\tremain_work_qty\ttarget_work_qty\ttarget_drtn_hr_cnt\ttarget_equip_qty\tact_equip_qty\tremain_equip_qty\tcstr_date\tact_start_date\tact_end_date\tlate_start_date\tlate_end_date\texpect_end_date\tearly_start_date\tearly_end_date\trestart_date\treend_date\ttarget_start_date\ttarget_end_date\trem_late_start_date\trem_late_end_date\tcstr_type\tpriority_type\tsuspend_date\tresume_date\tfloat_path\tfloat_path_order\tguid\ttmpl_guid\tcstr_date2\tcstr_type2\tdriving_path_flag\tact_this_per_work_qty\tact_this_per_equip_qty\texternal_early_start_date\texternal_late_end_date\tcreate_date\tupdate_date\tcreate_user\tupdate_user\tlocation_id');

  const startDate = new Date(schedule.start_date);
  const dayMs = 86400000;
  schedule.activities.forEach((a, idx) => {
    const taskId = 1000 + idx;
    const wbsId = wbsRootId + idx + 1;
    const startWk = a.start_week - 1;
    const start = new Date(startDate.getTime() + startWk * 7 * dayMs);
    const end = new Date(start.getTime() + a.duration * 7 * dayMs);
    const fmt = d => d.toISOString().slice(0, 10) + ' 07:00';
    lines.push(row('%R', taskId, projId, wbsId, 1, 0, 'N', 1, 'N', 'N', 'CP_Drtn', 'TT_Task', 'DT_FixedDUR2', 'TK_NotStart', `A${1000 + idx}`, a.name, '', 0, 0, a.duration * 7 * 8, 0, a.labour_hrs, a.labour_hrs, a.duration * 7 * 8, 0, 0, 0, '', '', '', fmt(start), fmt(end), '', fmt(start), fmt(end), '', '', fmt(start), fmt(end), '', '', 'CS_MEO', 'PT_Normal', '', '', '', '', '', '', '', '', 'N', 0, 0, '', '', exportDate, exportDate, 'admin', 'admin', ''));
  });

  // TASKPRED — finish-to-start chain
  lines.push('%T\tTASKPRED');
  lines.push('%F\ttask_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt\tcomments\tfloat_path\taref\tarls\tguid');
  schedule.activities.slice(1).forEach((a, i) => {
    lines.push(row('%R', 5000 + i, 1000 + i + 1, 1000 + i, projId, projId, 'PR_FS', 0, '', '', '', '', ''));
  });

  // %E — end of file marker
  lines.push('%E');

  fs.writeFileSync(outputPath, lines.join('\n') + '\n');
  return outputPath;
}

module.exports = { generate };

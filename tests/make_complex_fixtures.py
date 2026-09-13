#!/usr/bin/env python3
"""生成具有真实复杂度的测试夹具：
1. 5G 射频发射校准测试（/tmp/report-rf）：
   - 多 Sheet 模板（RF_Tx_Cal、Summary、Specs_Reference）
   - 目标表包含仪器环境元数据表头、Key 列位于 B 列、H 列为行级合格判定公式
   - Summary 表跨 Sheet 引用平均功率、最大 EVM、合格点数公式
   - XML 包含多层嵌套、仪器状态、带属性度量节点与无关频谱采样子节点
2. BMS 电池管理系统通道校准测试（/tmp/report-pmu）：
   - 32 个电芯测量通道、Key 列位于 C 列
   - 包含多级合并表头
   - 模版下方（Row 38~42）包含压差 (mV)、最大内阻、均值统计公式
   - XML 包含通道级测量指标、单位属性、采样诊断节点
"""
import os
import random
import sys
from openpyxl import Workbook


def make_rf_fixture(base_dir: str = "/tmp/report-rf") -> None:
    os.makedirs(base_dir, exist_ok=True)
    dataset = os.path.join(base_dir, "TD5G")
    os.makedirs(dataset, exist_ok=True)

    points = [f"TP_5G_N78_F{3300 + i * 25}_QAM64" for i in range(20)]

    # 1. 模板
    wb = Workbook()
    ws_cal = wb.active
    ws_cal.title = "RF_Tx_Cal"

    ws_cal.merge_cells("A1:J1")
    ws_cal["A1"] = "5G NR Transceiver Calibration & Verification Report"
    ws_cal.merge_cells("A2:D2")
    ws_cal["A2"] = "Station: RF-ATE-03 | Temp: 25.0°C | Chamber: C-2"
    ws_cal.merge_cells("E2:J2")
    ws_cal["E2"] = "Protocol: 3GPP TS 38.141-1 | Operator: OP-8821"

    headers = {
        "A4": "No.",
        "B4": "TestPoint_ID",
        "C4": "Frequency_MHz",
        "D4": "Tx_Power_dBm",
        "E4": "EVM_pct",
        "F4": "BER_rate",
        "G4": "ACLR_dBc",
        "H4": "Status",
        "I4": "Upper_Limit",
        "J4": "Notes",
    }
    for ref, text in headers.items():
        ws_cal[ref] = text

    for i, pt in enumerate(points):
        row = 5 + i
        ws_cal[f"A{row}"] = i + 1
        ws_cal[f"B{row}"] = pt
        ws_cal[f"C{row}"] = 3300 + i * 25
        # 行级判定公式：回填时必须被完整保护
        ws_cal[f"H{row}"] = f'=IF(AND(D{row}>=20,E{row}<=3.5,F{row}<=0.01,G{row}<=-35),"PASS","FAIL")'
        ws_cal[f"I{row}"] = "EVM<=3.5% | Pwr>=20"
        ws_cal[f"J{row}"] = f"ch_idx_{i}"

    # Summary 表
    ws_sum = wb.create_sheet("Summary")
    ws_sum["A1"] = "Overall Batch RF Summary"
    ws_sum["A3"], ws_sum["B3"], ws_sum["C3"] = "Metric", "Formula Value", "Spec Limit"
    ws_sum["A4"], ws_sum["B4"], ws_sum["C4"] = "Average Tx Power (dBm)", "=AVERAGE(RF_Tx_Cal!D5:D24)", ">= 20.0"
    ws_sum["A5"], ws_sum["B5"], ws_sum["C5"] = "Max EVM (%)", "=MAX(RF_Tx_Cal!E5:E24)", "<= 3.5"
    ws_sum["A6"], ws_sum["B6"], ws_sum["C6"] = "Worst BER", "=MAX(RF_Tx_Cal!F5:F24)", "<= 0.01"
    ws_sum["A7"], ws_sum["B7"], ws_sum["C7"] = "Total Passed Points", '=COUNTIF(RF_Tx_Cal!H5:H24,"PASS")', "20"

    # Specs 表（只读静态说明）
    ws_spec = wb.create_sheet("Specs_Reference")
    ws_spec["A1"] = "3GPP TS 38.141 Conformance Limits Reference"
    ws_spec["A2"] = "Frequency Band: n78 (3300 MHz - 3800 MHz)"
    ws_spec["A3"] = "Modulation: 64QAM | Channel Bandwidth: 100MHz"

    wb.save(os.path.join(base_dir, "template.xlsx"))

    # 2. 数据集（4 个 SN）
    rng = random.Random(42)
    sns = ["SN_5G_001", "SN_5G_002", "SN_5G_003", "SN_5G_004"]
    for sn_idx, sn in enumerate(sns):
        sn_dir = os.path.join(dataset, sn)
        os.makedirs(sn_dir, exist_ok=True)
        pts_xml = []
        for i, pt in enumerate(points):
            freq = 3300 + i * 25
            pwr = 23.1 + rng.uniform(-0.5, 0.6) + sn_idx * 0.05
            evm = 1.6 + rng.uniform(0.1, 0.8)
            ber = 0.0015 + rng.uniform(0.0001, 0.002)
            aclr = -38.5 + rng.uniform(-1.5, 1.2)
            pts_xml.append(f"""    <point id="{pt}">
      <freq_mhz>{freq}</freq_mhz>
      <measure metric="tx_pwr" val="{pwr:.2f}"/>
      <measure metric="evm" val="{evm:.2f}"/>
      <measure metric="ber" val="{ber:.4f}"/>
      <measure metric="aclr" val="{aclr:.1f}"/>
      <spectrum_trace points="1024" peak_dbm="{pwr + 0.5:.2f}"/>
    </point>""")

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<rf_device_report sn="{sn}" station="RF-ATE-03" timestamp="2026-09-12T10:30:00">
  <environment chamber="C-2" ambient_temp_c="25.2" vdd_volts="3.30"/>
  <calibration_chain id="CHAIN_01" rx_sync="locked">
{os.linesep.join(pts_xml)}
  </calibration_chain>
</rf_device_report>
"""
        with open(os.path.join(sn_dir, f"{sn}_rf_cal.xml"), "w", encoding="utf-8") as fh:
            fh.write(xml_content)

    print(f"5G RF fixture ready at {base_dir} (20 points x 4 SNs, 3 sheets)")


def make_pmu_fixture(base_dir: str = "/tmp/report-pmu") -> None:
    os.makedirs(base_dir, exist_ok=True)
    dataset = os.path.join(base_dir, "TDBMS")
    os.makedirs(dataset, exist_ok=True)

    channels = [f"CELL_CH_{i + 1:02d}" for i in range(32)]

    # 1. 模板
    wb = Workbook()
    ws_cell = wb.active
    ws_cell.title = "Cell_Matrix"

    ws_cell.merge_cells("A1:H1")
    ws_cell["A1"] = "BMS 32-Channel Cell Voltage & Impedance Calibration Matrix"
    ws_cell.merge_cells("A2:D2")
    ws_cell["A2"] = "Tester: Chroma-8000 | Fixture: FX-BMS-09"
    ws_cell.merge_cells("E2:H2")
    ws_cell["E2"] = "Batch: 202609-BMS | Standard: IEC 62619"

    headers = {
        "A4": "No.",
        "B4": "Module",
        "C4": "Channel_Code",
        "D4": "V_ocv_V",
        "E4": "R_int_mOhm",
        "F4": "I_leak_uA",
        "G4": "Temp_Rise_K",
        "H4": "Cell_Status",
    }
    for ref, text in headers.items():
        ws_cell[ref] = text

    for i, ch in enumerate(channels):
        row = 5 + i
        ws_cell[f"A{row}"] = i + 1
        ws_cell[f"B{row}"] = f"MOD_{i // 8 + 1:02d}"
        ws_cell[f"C{row}"] = ch
        ws_cell[f"H{row}"] = f'=IF(AND(D{row}>=3.0,D{row}<=4.2,E{row}<=2.0),"OK","CHECK")'

    # 模版下方统计区（Row 38~41），验证写入器精准控行不覆盖统计区
    ws_cell["C38"] = "Average Voltage (V)"
    ws_cell["D38"] = "=AVERAGE(D5:D36)"
    ws_cell["C39"] = "Max Delta V (mV)"
    ws_cell["D39"] = "=(MAX(D5:D36)-MIN(D5:D36))*1000"
    ws_cell["C40"] = "Max Internal Resistance (mOhm)"
    ws_cell["E40"] = "=MAX(E5:E36)"
    ws_cell["C41"] = "Total OK Cells"
    ws_cell["H41"] = '=COUNTIF(H5:H36,"OK")'

    # Pack Summary
    ws_sum = wb.create_sheet("Pack_Summary")
    ws_sum["A1"] = "Pack Level Overview"
    ws_sum["A2"] = "Nominal Pack Voltage: 102.4V (32S LFP)"

    wb.save(os.path.join(base_dir, "template.xlsx"))

    # 2. 数据集（4 个 SN）
    rng = random.Random(101)
    sns = ["BMS_PACK_001", "BMS_PACK_002", "BMS_PACK_003", "BMS_PACK_004"]
    for sn_idx, sn in enumerate(sns):
        sn_dir = os.path.join(dataset, sn)
        os.makedirs(sn_dir, exist_ok=True)
        ch_xml = []
        for i, ch in enumerate(channels):
            vocv = 3.3210 + rng.uniform(-0.015, 0.018) + sn_idx * 0.002
            rint = 0.45 + rng.uniform(0.01, 0.15)
            leak = 1.1 + rng.uniform(0.05, 0.35)
            temp = 1.7 + rng.uniform(0.1, 0.4)
            ch_xml.append(f"""    <channel_step code="{ch}" channel_idx="{i + 1}">
      <metric name="v_ocv" val="{vocv:.4f}" unit="V"/>
      <metric name="r_int" val="{rint:.3f}" unit="mOhm"/>
      <metric name="i_leak" val="{leak:.2f}" unit="uA"/>
      <metric name="temp_rise" val="{temp:.2f}" unit="K"/>
      <raw_sample sampling_rate_hz="1000" duration_ms="50"/>
    </channel_step>""")

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<bms_eot_report pack_sn="{sn}" station="EOL-STATION-04" start_time="2026-09-12 11:20:00">
  <pack_meta nominal_capacity_ah="100" cell_count="32" chemistry="LFP"/>
  <sequence stage="eot_calibration">
{os.linesep.join(ch_xml)}
  </sequence>
</bms_eot_report>
"""
        with open(os.path.join(sn_dir, f"{sn}_pmu_test.xml"), "w", encoding="utf-8") as fh:
            fh.write(xml_content)

    print(f"BMS PMU fixture ready at {base_dir} (32 channels x 4 SNs, bottom summary formulas)")


def main() -> None:
    make_rf_fixture()
    make_pmu_fixture()


if __name__ == "__main__":
    main()

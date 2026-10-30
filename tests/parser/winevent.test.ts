import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { buildLogIndex, isErrorRow } from '../../src/filters/logIndex';

const sample = readFileSync('fixtures/sample-eventlog.xml', 'utf8');

/** Event Viewer's "Save as XML": namespaced, indented, with named data and a rendered message. */
const viewerExport = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Events>
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System>
    <Provider Name="Microsoft-Windows-WAS" Guid="{524B5D04-133C-4A62-8362-64E8EDB9CE40}" EventSourceName="WAS"/>
    <EventID Qualifiers="32768">5011</EventID>
    <Level>3</Level>
    <TimeCreated SystemTime="2026-03-14T08:00:00.1234567Z"/>
    <EventRecordID>77</EventRecordID>
    <Execution ProcessID="1880" ThreadID="2004"/>
    <Channel>System</Channel>
    <Computer>web01.example.test</Computer>
  </System>
  <EventData>
    <Data Name="AppPoolID">ShopApi</Data>
    <Data Name="ProcessID">4242</Data>
  </EventData>
  <RenderingInfo Culture="en-US">
    <Message>A process serving application pool 'ShopApi' suffered a fatal communication error.</Message>
    <Level>Warning</Level>
  </RenderingInfo>
</Event>
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System>
    <Provider Name="Service Control Manager"/>
    <EventID>7036</EventID>
    <Level>0</Level>
    <TimeCreated SystemTime="2026-03-14T08:00:05Z"/>
  </System>
  <EventData>
    <Data Name="param1">World Wide Web Publishing Service</Data>
    <Data Name="param2">running</Data>
  </EventData>
</Event>
</Events>
`;

describe('Windows Event Log XML parser', () => {
  const r = parseText(sample);

  it('is detected from the <Event> elements', () => {
    expect(detectFormat(splitLines(sample))).toBe('winevent');
    expect(detectFormat(splitLines(viewerExport))).toBe('winevent');
    expect(r.format).toBe('winevent');
  });

  it('makes one row per event, even when events share a line or span several', () => {
    expect(r.malformed).toHaveLength(0);
    expect(r.rows.map((x) => [x.lineNo, x.values.eventId, x.values.level])).toEqual([
      [1, 1026, 'Error'],
      [5, 1007, 'Critical'],
      [6, 1032, 'Information'],
    ]);
    expect(r.timeZone.kind).toBe('utc');
    expect(r.rows[0]!.ts).toBe(Date.parse('2026-03-14T09:30:01Z'));
  });

  it('fills the message from the event data, with entities decoded', () => {
    expect(r.rows[0]!.values.message).toBe(
      'Application: w3wp.exe\nDescription: The process was terminated due to an unhandled exception.\n' +
        'Exception Info: System.InvalidOperationException: Shop:ApiKey is not configured.\n' +
        '   at Program.<Main>$(String[] args) in C:\\src\\Shop\\Program.cs:line 42',
    );
    expect(r.rows[1]!.values.message).toBe("Application 'C:\\inetpub\\shop\\' failed to load coreclr.\nProcess Id: 4242.");
    expect(r.rows[1]!.values).toMatchObject({ provider: 'IIS AspNetCore Module V2', channel: 'Application', computer: 'WEB01', recordId: 1002 });
    expect(r.rows[1]!.raw).toMatch(/^<Event><System>.*<\/Event>$/);
  });

  it('counts Critical and Error events as errors', () => {
    const index = buildLogIndex(r.rows, r.schema);
    expect(r.rows.map((_, i) => isErrorRow(index, i))).toEqual([true, true, false]);
  });

  it("reads Event Viewer exports: rendered message and level, named data, level 0", () => {
    const v = parseText(viewerExport);
    expect(v.malformed).toHaveLength(0);
    expect(v.rows).toHaveLength(2);
    expect(v.rows[0]!.lineNo).toBe(3);
    expect(v.rows[0]!.values).toMatchObject({
      level: 'Warning',
      provider: 'Microsoft-Windows-WAS',
      eventId: 5011,
      message: "A process serving application pool 'ShopApi' suffered a fatal communication error.",
      channel: 'System',
      processId: 1880,
    });
    expect(v.rows[1]!.values).toMatchObject({
      level: 'Information',
      message: 'param1: World Wide Web Publishing Service\nparam2: running',
    });
  });

  it('reports an event cut off at the end of the file', () => {
    const cut = sample.slice(0, sample.lastIndexOf('</Event>'));
    const t = parseText(cut, 'winevent');
    expect(t.rows).toHaveLength(2);
    expect(t.malformed).toEqual([expect.objectContaining({ lineNo: 6, reason: expect.stringContaining('Incomplete') })]);
  });
});

import fs, { promises as fsPromises } from 'fs';
import { format } from 'util';
import { basename, extname } from 'path';

import React, { SyntheticEvent, useState } from 'react';
import id3, { Tags } from 'node-id3';
import { DateTime, Duration } from 'luxon';
import Puppet, { Browser } from 'puppeteer';
import * as mm from 'music-metadata';

import { ReaperReader } from '../../tools/ReaperReader';
import { ItemParser } from '../../tools/ItemParser';
import Orchestrator from '../../tools/Orchestrator';

import { DataType, SegmentType, SOCANType } from './SquareSymTypes/enums';
import { ShowData, ShowChapterData, SegmentChapterData, MusicChapterData, CartChapterData, AlternateData } from './SquareSymTypes/interfaces';

const testOverride = false;

// HACK: temporary until we come up with better output
const econsole = console;

const sqsyCompanion = require('./SquareSymTypes/companion.json');

const CKDU_NEWTRACK_MAXMONTHS = 6;

const BASE_OUTPUTPATH = './output/SquareSym/';
const BASE_DATAPATH = './showdata/SquareSym/';

const makeOrdinal = (date: string) => {
  const dateNum = parseInt(date);
  if (Math.floor(dateNum / 10) % 10 === 1) return `${dateNum}th,`;
  else switch (dateNum % 10) {
    case 1: return `${dateNum}st,`
    case 2: return `${dateNum}nd,`
    case 3: return `${dateNum}rd,`
    default: return `${dateNum}th,`
  }
}

type ChapterData = {
  elementID: string;
  startTimeMs: number;
  endTimeMs: number;
  tags: Tags;
}
type ImageData = Tags['image'];

type TagProcessOptions = {
  inputfileObj: File | null;
  makeLog: boolean;
  doUpload: boolean;
  browser?: Promise<Browser>;
}
type GenerateTagsOptions = {
  /** The location of the output file. */
  outputfile: string;
  /** The base path where the music is contained. */
  musicPath: string | null;
  /** A promise which resolves into the length, in seconds, of the podcast episode. */
  length: Promise<number>;
}
type GenerateTagsOutput = {
  tags: id3.Tags;
  masterList: AlternateData[];
  simpleSegList: string[];
  segMusic: AlternateData[];
  playMusic: AlternateData[];
}
type GenerateCompanionOptions = {
  /** A basic list of the segments to be processed. */
  simpleSegList: string[],
  /** Alternate data for segment music being used. */
  segMusic: AlternateData[],
  /** Alternate data for featured tracks being used. */
  playMusic?: AlternateData[]
}
type CompanionOperation = (data: ShowData, options: GenerateCompanionOptions) => Promise<string>;
type BrowserOperation = (data: ShowData, browser: Browser) => Promise<void>;
type SquareSymOpsType = {
  running: boolean;

  TagProcess: (data: ShowData, options: TagProcessOptions) => Promise<void>;
  ReaperProcess: (inputfile: string, reaperData: ReaperReader) => Promise<void>;

  FindMusicPath: (data: ShowData, datestamp: string | any[]) => string | null;
  GenerateTags: (data: ShowData, { outputfile, musicPath }: GenerateTagsOptions) => GenerateTagsOutput;
  FetchExternalTags: (sourceFile: string, showDate?: DateTime) => AlternateData;
  GenerateEndCredits: CompanionOperation;
  GenerateLongDescription: CompanionOperation;
  GenerateStreamPlaylist: (data: ShowData, masterList: AlternateData[]) => Promise<string>;

  UploadPodcastEpisode: BrowserOperation;
  ComposeStationLog: BrowserOperation;
}
const SquareSymOps: SquareSymOpsType = {
  running: false,

  TagProcess: async (data, { inputfileObj, makeLog, doUpload, browser }) => {
    if (SquareSymOps.running) {
      econsole.error('SquareSym process already running.');
      return;
    }
    SquareSymOps.running = true;

    const { FindMusicPath, GenerateTags, ComposeStationLog, UploadPodcastEpisode,
      GenerateEndCredits, GenerateLongDescription, GenerateStreamPlaylist } = SquareSymOps;
    const inputfile = inputfileObj ? inputfileObj.name : null;
    const inputfileBuffer = inputfileObj ? inputfileObj.arrayBuffer().then(buffer => Buffer.from(buffer)) : null;

    if (data.description.length > 255) throw new Error(`Description too long (${data.description.length} chars, max is 255)`);
    if (data.SOCAN) econsole.warn('This is a SOCAN episode. All segments except carts must contain SOCANTime field.')

    if (!inputfile) econsole.warn('No input file specified. Will not be tagging episode.');

    let datestamp = DateTime.fromFormat(data.airdate, 'DDD').toFormat('yyyyMMdd');

    const { sendSignal } = Orchestrator;
    const outputfile: string =
      (data.season === 'SP' ? `SP` : `S${data.season.toString().padStart(2, '0')}E`) +
      `${data.episode.toString().padStart(2, '0')} ${data.title}`;

    const logOperation = (makeLog && browser) ? ComposeStationLog(data, await browser) : null;
    const uploadOperation = (doUpload && inputfile && browser) ? UploadPodcastEpisode(data, await browser) : null;
    if (logOperation || uploadOperation) econsole.info('Starting automated browser operation(s)...');

    let length: Promise<number> = inputfileBuffer
      ? mm.parseBuffer(await inputfileBuffer, 'audio/mpeg', { duration: true })
        .then(data => data.format.duration ? Math.floor(data.format.duration * 1000) : 3300000)
      : Promise.resolve(3300000);

    econsole.info('Finding music path...');
    const musicPath = FindMusicPath(data, datestamp);
    sendSignal('musicPath', musicPath);

    econsole.info('Generating tags...');
    let { tags, masterList, simpleSegList, segMusic, playMusic } = GenerateTags(data, { outputfile, length, musicPath });
    sendSignal('tags', { tags, masterList, simpleSegList, segMusic, playMusic });
    //econsole.debug(masterList);

    const tagOperation = inputfileBuffer ? (async () => {
      econsole.info('Waiting for audio length...');
      tags.length = (await length).toString();
      for (let chap of tags.chapter!) if (chap.endTimeMs < 0) chap.endTimeMs = await length;
      sendSignal('length', tags.length);

      if (!fs.existsSync('./output') || !fs.existsSync('./output/SquareSym')) fs.mkdirSync(BASE_OUTPUTPATH, { recursive: true });

      const outputPath = `${BASE_OUTPUTPATH}${outputfile}.mp3`;
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

      econsole.info('Writing tags to MP3...');
      await id3.Promise.write(tags, await inputfileBuffer)
        .then(buffer => fsPromises.writeFile(outputPath, buffer));
      sendSignal('mp3tag', outputPath);
    })() : null;

    const companionOperation = (async () => {
      econsole.info('Generating companion data...');
      let credits: Promise<string> = GenerateEndCredits(data, { simpleSegList, segMusic });
      let longdesc: Promise<string> = GenerateLongDescription(data, { simpleSegList, segMusic, playMusic });
      let streamPL: Promise<string> = GenerateStreamPlaylist(data, masterList);

      econsole.info('Writing companion data...');
      fs.writeFileSync(`${BASE_OUTPUTPATH}${outputfile}.credits.txt`, await credits);
      fs.writeFileSync(`${BASE_OUTPUTPATH}${outputfile}.longdesc.txt`, await longdesc);
      fs.writeFileSync(`${BASE_OUTPUTPATH}playlist.txt`, await streamPL);
      sendSignal('companion', { credits: await credits, longdesc: await longdesc, streamPL: await streamPL });
    })();

    await Promise.all([logOperation, uploadOperation, tagOperation, companionOperation]);

    if (browser) {
      econsole.info('Closing automated browser...');
      await (await browser).close();
    }

    econsole.info('Done.');
    let songsPlayed = segMusic.length + playMusic.length;
    let CanConAmount = masterList.reduce((r, i) => i.CanCon ? ++r : r, 0), CanConRate = Math.round(CanConAmount / songsPlayed * 1000) / 10;
    econsole.info(`CanCon rate: ${CanConAmount}/${songsPlayed} (${CanConRate}%)`);
    const CanConTarget = data.SOCAN ? 40 : 12;
    if (CanConRate < CanConTarget) econsole.warn(`WARNING: CanCon rate is under ${CanConTarget}%; consider changing music`);

    SquareSymOps.running = false;
  },

  ReaperProcess: async (inputfile: string, reaperData: ReaperReader) => {
    //const reaperData = ReaperReader.fromFile(inputfile);
    const showDate = DateTime.fromISO(basename(inputfile).substr(0, 8));
    let retval: ShowData = {
      title: basename(inputfile, '.rpp').substr(9),
      season: 0,
      episode: 0,
      year: (new Date()).getFullYear(),
      airdate: showDate.toFormat('MMMM dd, yyyy'),
      description: '',
      chapters: [],
      nextOnCKDU: {}
    };

    reaperData.querySelector('MARKER')
      .filter(i => {
        for (const param of i.params) { if (/^\{[\dA-F-]{36}\}$/i.test(param as string)) return false; }
        return true;
      }).forEach((i, x) => {
        retval.chapters.push({
          type: DataType.Carts,
          start: Math.round(i.params[1] as number * 1000),
          estTime: showDate.plus({ hours: 17, minutes: x * 2, seconds: parseInt(i.params[1].toString()) }).toFormat('h:mm a').toLowerCase()
        } as CartChapterData);
      });
    retval.chapters.pop();

    const musicTrack = ReaperReader.nodeContains(reaperData.querySelector('TRACK'), 'NAME', 'Music Track')[0];
    const voiceTrack = ReaperReader.nodeContains(reaperData.querySelector('TRACK'), 'NAME', 'Kewlio')[0];
    const musicItems = ReaperReader.querySelectorAgain(musicTrack, 'ITEM').map(i => new ItemParser(i));
    const voiceItems = ReaperReader.querySelectorAgain(voiceTrack, 'ITEM').map(i => new ItemParser(i));

    musicItems.forEach(i => {
      if (i.name.startsWith('SEG ')) {
        // Starts with SEG - this is a voice segment
        let newSeg: SegmentChapterData = {
          type: DataType.Segment,
          start: Math.round(i.start * 1000)
        }

        switch (true) {
          case i.name.startsWith('SEG 00'):
            newSeg.segType = SegmentType.GoCall;
            newSeg.contentLength = Duration.fromObject({ minutes: 0, seconds: Math.round(i.length) }).normalize().toISO();
            break;
          case i.name.startsWith('SEG 01'):
            newSeg.segType = SegmentType.Intro;
            break;
          case i.name.startsWith('SEG 02'): {
            newSeg.segType = SegmentType.FromTheArchives;
            newSeg.game = '';
            newSeg.gameId = 0;

            let lastMusic = retval.chapters.pop();
            if (lastMusic) {
              if (lastMusic.type === DataType.Music) (lastMusic as MusicChapterData).archives = true;
              retval.chapters.push(lastMusic);
            }
          } break;
          case i.name.startsWith('SEG 03'):
            newSeg.segType = SegmentType.NewsOfTheWeird;
            //console.debug(showDate.format('YYYY/M/D'), moment(showDate).subtract(1, 'week').format('YYYY/M/D'));
            newSeg.newsDate = showDate.minus({ weeks: 1 }).toFormat('y/M/d')
            break;
          case i.name.startsWith('SEG 04'):
            newSeg.segType = SegmentType.GamingNextMonth;
            newSeg.title = showDate.plus({ weeks: 2 }).toFormat('MMMM y');
            break;
          case i.name.startsWith('SEG 05'):
            newSeg.segType = SegmentType.VGin10Minutes;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 06'):
            newSeg.segType = SegmentType.Introspective;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 07'):
            newSeg.segType = SegmentType.BestOfTheWorst;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 08'):
            newSeg.segType = SegmentType.Review;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 09'):
            newSeg.segType = SegmentType.Interview;
            newSeg.guest = '';
            break;
          case i.name.startsWith('SEG 10'):
            newSeg.segType = SegmentType.NotQuiteLife;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 11'):
            newSeg.segType = SegmentType.VGHistory;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 12'):
            newSeg.segType = SegmentType.IFoundAThing;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 13'):
            newSeg.segType = SegmentType.GameShowGeek;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 14'):
            newSeg.segType = SegmentType.RapidReview;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 15'):
            newSeg.segType = SegmentType.DialogBox;
            newSeg.guest = '';
            break;
          case i.name.startsWith('SEG 16'):
            newSeg.segType = SegmentType.Miscellaneous;
            newSeg.title = '';
            break;
          case i.name.startsWith('SEG 98'):
            // This is actually to be listed as a cart
            break;
          case i.name.startsWith('SEG 99'):
            newSeg.segType = SegmentType.LeadOut;
            break;
        }

        if (!newSeg.contentLength) newSeg.contentLength = Duration.fromObject({
          hours: 0, minutes: 0,
          seconds: Math.round(
            voiceItems.filter(ii =>
              ii.start > i.start && ii.start < i.end
            ).reduce((r, i) => r + i.length, 0)
          )
        }).normalize().toISO();

        retval.chapters.push(newSeg);
      } else if (i.name.startsWith('SEGLOOP ')) {
        // Segment continues - segment music has intro and loop parts
        // probably do nothing? maybe revise some numbers
      } else {
        // Doesn't start with SEG - it's a music segment
        let newTrack: MusicChapterData = {
          type: DataType.Music,
          start: Math.round(i.start * 1000),
          from: i.source
        };
        retval.chapters.push(newTrack);
      }
    });

    retval.chapters.sort((lhs: ShowChapterData, rhs: ShowChapterData) => {
      if ((lhs.start as number) === (rhs.start as number)) {
        if (lhs.type === rhs.type) return 0;
        if (lhs.type === DataType.Carts) return -1;
        if (rhs.type === DataType.Carts) return 1;
        return 0;
      }
      else if ((lhs.start as number) < (rhs.start as number)) return -1;
      else return 1;
    });

    if (!fs.existsSync('./showdata') || !fs.existsSync('./showData/SquareSym')) fs.mkdirSync(BASE_DATAPATH, { recursive: true });

    const outfile = `${BASE_DATAPATH}${showDate.toFormat('yyyyMMdd')}.json`;
    if (fs.existsSync(outfile)) fs.unlinkSync(outfile);
    fs.writeFileSync(outfile, JSON.stringify(retval, undefined, 2));
  },

  /**
   * Locates the base path where the music and data files will be located for this episode.
   * @param data The episode's data.
   * @param datestamp The datestamp for this episode.
   */
  FindMusicPath: (data: ShowData, datestamp: string | any[]) => {
    const season = data.season.toString();

    let dirs = fs.readdirSync(`${BASE_DATAPATH}S${season}/`, { withFileTypes: true })
      .filter(i => i.isDirectory() && i.name.substr(0, season.length) === season)
      .map(i => i.name);

    for (let dir of dirs) {
      let subdirs = fs.readdirSync(`${BASE_DATAPATH}S${season}/${dir}/`, { withFileTypes: true })
        .filter(i => i.isDirectory() && i.name.substr(0, datestamp.length) === `${datestamp}` && i.name.includes(data.title))
        .map(i => i.name);
      if (subdirs.length > 0) return `${BASE_DATAPATH}S${season}/${dir}/${subdirs[0]}/`;
    }

    return null;
  },

  /**
   * Generates the ID3 tag data for the podcast episode.
   * @param data The episode's data.
   * @param param1 The input for this function.
   */
  GenerateTags: (data: ShowData, { outputfile, musicPath }: GenerateTagsOptions) => {
    const { FetchExternalTags } = SquareSymOps;
    let subtitle = /^[\da-z]+\b/i.exec(outputfile);

    let tags: id3.Tags = {
      title: data.title,
      subtitle: subtitle ? subtitle[0] : '',
      trackNumber: data.episode.toString(),
      partOfSet: data.season.toString(),
      album: 'Squarewave Symphony',
      artist: 'KewlioMZX',
      comment: {
        language: 'eng',
        text: data.description
      },
      artistUrl: [
        'https://lowbiasgaming.net/squaresym',
        'https://twitter.com/SquareSym'
      ],
      mediaType: '(RAD/FM)',
      radioStationUrl: 'https://ckdu.ca/',
      internetRadioName: 'CKDU 88.1 FM Halifax',
      internetRadioOwner: 'Dalhousie University',
      genre: 'Podcast',
      language: 'English',
      length: '0',
      year: data.year.toString(),
      originalFilename: `${outputfile}.mp3`,
      image: `${BASE_DATAPATH}Seg/_mainlogo.png`,
      chapter: []
    };

    let simpleSegList: string[] = [];
    let masterList: AlternateData[] = [];
    let segMusic: AlternateData[] = [];
    let playMusic: AlternateData[] = [];

    let lastStartPos: number = 72000000; // 2 hours
    for (let chap of data.chapters.slice().reverse()) {
      if (typeof chap.start == 'string') {
        chap.start = Math.round(Duration.fromISO(chap.start).as('milliseconds'));
      }
      if (typeof chap.start != 'number') {
        chap.start = lastStartPos;
        if (chap.type !== DataType.Carts) chap.start--;
      }
      lastStartPos = chap.start;
    }
    data.chapters[0].start = 0;

    let cartCount: number = 0;
    for (let x in data.chapters) {
      let nx: number = Number.parseInt(x);
      let item = data.chapters[x];
      let chap: ChapterData = {
        elementID: `chp${nx - cartCount}`,
        startTimeMs: item.start as number,
        endTimeMs: item.start as number,
        tags: { title: '' }
      };

      let url: string | null = null;

      if (item.end) chap.endTimeMs = item.end as number;
      else if (data.chapters.length > nx + 1) chap.endTimeMs = data.chapters[nx + 1].start as number;
      else chap.endTimeMs = -1;

      let altData: AlternateData = { type: item.type };
      switch (item.type) {
        case DataType.Segment:
          let sItem = item as SegmentChapterData;
          simpleSegList.push(sItem.segType!);
          chap.tags.image = `${BASE_DATAPATH}Seg/sqsy.png`;
          switch (sItem.segType) {
            case SegmentType.GoCall:
              chap.tags.title = 'Opening bumper';
              break;

            case SegmentType.Intro:
              chap.tags.title = `Intro & What's New ${sItem.inAndAround ? 'in and around' : 'at'} LowBiasGaming`;
              url = 'https://lowbiasgaming.net/';
              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                artist: 'KewlioMZX',
                songTitle: 'Heat Wave',
                songImage: `${BASE_DATAPATH}Seg/sqsy.png`,
                CanCon: true,
                songUrl: 'https://kewliomzx.bandcamp.com/'
              });
              break;

            case SegmentType.FromTheArchives:
              chap.tags.title = `From the Archives: ${sItem.game}`;
              chap.tags.image = `${BASE_DATAPATH}Seg/Archives.png`;
              if (sItem.gameId) url = `https://lowbiasgaming.net/playlist.php?gameid=${sItem.gameId}`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `From the Archives~~${sItem.game}`,
                artist: 'Manabu Namiki, Noriyuki Kamikura',
                songTitle: 'Gentle Breeze',
                displaySong: 'M.Namiki, N.Kamikura~~Gentle Breeze',
                album: 'Trauma Center 2: Under the Knife OST',
                songImage: `${BASE_DATAPATH}Mus/Seg/archives-breeze.jpg`
              });
              break;

            case SegmentType.NewsOfTheWeird:
              chap.tags.title = 'News of the Weird';
              chap.tags.image = `${BASE_DATAPATH}Seg/notw.png`;
              if (sItem.guest) chap.tags.title += ` w/ ${sItem.guest}`;
              if (sItem.weather) chap.tags.title += ' & Halifax Weather';
              if (sItem.newsDate) url = `https://uexpress.com/news-of-the-weird/${sItem.newsDate}`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: chap.tags.title,
                artist: 'twilight/defekt',
                songTitle: 'feel the vibes',
                songUrl: 'https://modarchive.org/index.php?request=view_by_moduleid&query=123799',
                tracker: { crtc: 11 }
              });
              break;

            case SegmentType.Review:
              // TODO: add support for individual reviews in a multireview
              chap.tags.title = `Review: ${item.title}`;
              chap.tags.image = `${BASE_DATAPATH}Seg/review.png`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `Review~~${item.displayTitle ?? item.title}`,
                artist: 'Nifflas',
                songTitle: 'An Underwater Adventure (Mix B)'
              });
              break;

            case SegmentType.IFoundAThing:
              chap.tags.title = `I Found a Thing: ${item.title}`;
              chap.tags.image = `${BASE_DATAPATH}Seg/foundthing.png`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `I Found a Thing~~${item.displayTitle ?? item.title}`,
                artist: 'Pink Projects',
                songTitle: 'alloy_run'
              });
              break;

            case SegmentType.GamingNextMonth:
              chap.tags.title = `Gaming Next Month: ${item.title}`;
              chap.tags.image = `${BASE_DATAPATH}Seg/gnm.png`;
              url = `https://gameinformer.com/${item.title!.replace(/[^\d]/g, '')}`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `Gaming Next Month~~${item.title}`,
                artist: 'Shawn Daley',
                songTitle: 'Level 66',
                songImage: `${BASE_DATAPATH}Mus/Seg/gnm-level66.png`,
                CanCon: true,
                songUrl: 'https://shawndaley.ca/'
              });
              break;

            case SegmentType.RapidReview:
              chap.tags.title = `Rapid Review Rampage: ${item.title}`;
              chap.tags.image = `${BASE_DATAPATH}Seg/review.png`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `Rapid Review Rampage~~${item.displayTitle ?? item.title}`,
                artist: 'zandax',
                songTitle: 'central park',
                songUrl: 'https://modarchive.org/index.php?request=view_profile&query=68935'
              });
              break;

            case SegmentType.Introspective:
              chap.tags.title = `Introspective: ${item.title}`;
              chap.tags.image = `${BASE_DATAPATH}Seg/introspective.png`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `Introspective~~${item.displayTitle ?? item.title}`,
                artist: 'Gigandect',
                songTitle: 'Dolphins are alright',
                songImage: `${BASE_DATAPATH}Mus/Seg/is-dolphins.jpg`
              });
              break;

            case SegmentType.Interview:
              // TODO: Interview pic
              chap.tags.title = `Interview: ${item.title}`;
              //chap.tags.image = `${BASE_DATAPATH}Seg/interview.png`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `Interview~~${item.displayTitle ?? item.title}`,
                artist: 'whalebone',
                songTitle: 'double trouble'
              });
              break;

            case SegmentType.VGin10Minutes:
              chap.tags.title = `Video Games in 10 Minutes or Less: ${sItem.game}`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `VG in 10 Minutes or Less~~${item.displayTitle ?? sItem.game}`,
                artist: 'Reverb',
                songTitle: 'altar_of_light'
              });
              break;

            case SegmentType.VGHistory:
              chap.tags.title = `Video Game History: ${item.title}`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: item.displayTitle ?? `Video Game History~~${item.title}`,
                artist: 'CHIBINOIZE',
                songTitle: 'Neon Lights',
                songImage: `${BASE_DATAPATH}Mus/Seg/is-dolphins.jpg`,
                songUrl: 'https://soundcloud.com/chibinoize/'
              });
              break;

            case SegmentType.GameShowGeek:
              chap.tags.title = `The Game Show Geek: ${item.title}`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: item.displayTitle ?? `The Game Show Geek~~${item.title}`,
                artist: 'radix',
                songTitle: 'rainy summerdays',
                songUrl: 'https://modarchive.org/index.php?request=view_by_moduleid&query=67590'
              });
              break;

            case SegmentType.DialogBox:
              chap.tags.title = `The Dialog Box w/ ${sItem.guest}`;
              chap.tags.image = `${BASE_DATAPATH}Seg/dialogbox.png`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `The Dialog Box~~w/ ${sItem.guest}`,
                artist: 'Jarkko Virtanen',
                songTitle: 'alva usa kicknose'
              });
              break;

            case SegmentType.Miscellaneous:
              chap.tags.title = `Miscellaneous: ${item.title}`;

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `Miscellaneous~~${item.title}`,
                artist: 'Yerzmyey',
                songTitle: 'Cybernetic Celtic Wizard',
                songUrl: 'https://soundcloud.com/yerzmyey/'
              });
              break;

            case SegmentType.LeadOut:
              chap.tags.title = 'Lead-out';
              url = 'https://lowbiasgaming.net/squaresym';

              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                displayTitle: `Lead-out`,
                artist: 'Kommisar',
                songTitle: 'Cherry Cola',
                CanCon: true,
                songUrl: 'https://soundcloud.com/kommisar/',
                songImage: `${BASE_DATAPATH}Mus/Seg/out-cherrycola.jpg`
              });
              break;

            default:
              chap.tags.title = item.title ?? `Undefined segment ${sItem.segType}`;
              altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
                artist: sItem.artist,
                songTitle: sItem.songTitle,
                album: sItem.album,
                CanCon: sItem.CanCon
              });
              break;
          }
          if (!altData.tracker) altData.tracker = { crtc: 12 };
          altData.tracker.length = Duration.fromISO(sItem.contentLength!);
          break;

        case DataType.Music:
          let mItem = item as MusicChapterData;
          if (mItem.from && !musicPath) throw new Error(`Can't use tag source ${mItem.from}; No music path found for episode`);
          altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, mItem.from ? FetchExternalTags(`${musicPath}${mItem.from}`) : {
            artist: mItem.artist,
            songTitle: mItem.title,
            album: mItem.album,
            CanCon: mItem.CanCon,
            image: chap.tags.image,
            tracker: { crtc: mItem.crtc ?? 21 }
          });
          if (altData.artist) altData.artist = altData.artist.replace(/﻿/g, ', ');
          altData.archives = mItem.archives;
          if (!altData.tracker) altData.tracker = { crtc: mItem.crtc ?? 21 };
          if (mItem.hasLyrics) altData.tracker.hasLyrics = mItem.hasLyrics;
          if (mItem.newSong) altData.tracker.newSong = mItem.newSong;
          if (mItem.displaySong) altData.displaySong = mItem.displaySong;

          chap.tags.title = `${altData.artist} - ${altData.songTitle}`;
          if (altData.album) chap.tags.title += ` [${altData.album}]`;
          if (altData.CanCon) chap.tags.title += ' 🍁';
          if (altData.songUrl) url = altData.songUrl;
          else if (url) altData.songUrl = url;
          if (altData.image) {
            if (altData.image instanceof Object) chap.tags.image = altData.image;
            else chap.tags.image = altData.image = `${BASE_DATAPATH}Mus/${data.season}/${data.episode}/${altData.image}`;
          }

          playMusic.push(altData);
          break;

        case DataType.Carts:
          let cItem = item as CartChapterData;
          cartCount++;
          altData = Object.assign<AlternateData, Partial<AlternateData>>(altData, {
            title: cItem.title ?? 'Carts',
            displayTitle: 'Station Break',
            image: `${BASE_DATAPATH}Seg/carts.png`,
            displaySong: 'Station Break',
            songImage: `${BASE_DATAPATH}Seg/carts.png`,
            tracker: { crtc: cItem.crtc ?? 51, timePlayed: cItem.estTime ?? '5:00 pm' }
          });
          break;

        default:
          chap.tags.title = `Unknown type ${item.type}`;
          break;
      }

      if (!(item.type === DataType.Segment && (item as SegmentChapterData).segType === SegmentType.GoCall)) {
        if (item.type !== DataType.Carts) {
          if (data.SOCAN) {
            if (!item.SOCANTime) throw new Error(`No play time specified for ${item.title ?? altData.displayTitle ?? altData.songTitle} (required for SOCAN period)`);

            let socanType: SOCANType;
            if (item.type === DataType.Segment) {
              if ((item as SegmentChapterData).segType === SegmentType.Intro) socanType = SOCANType.Theme;
              else socanType = SOCANType.Background;
            } else socanType = SOCANType.Neither;

            altData.tracker!.SOCAN = {
              type: socanType,
              time: item.SOCANTime
            }
          }

          if (item.image) chap.tags.image = item.image;
          if (item.url) url = item.url;

          if (url) chap.tags.userDefinedUrl = [{ description: 'chapter url', url }];
          tags.chapter!.push(chap);

          altData.title = chap.tags.title;
          altData.image = chap.tags.image;
          if (url) altData.url = url;
          if (!altData.songImage) altData.songImage = `${BASE_DATAPATH}Mus/Seg/genericmusic.jpg`;
          if (item.type === DataType.Segment) segMusic.push(altData);
        }
        masterList.push(altData);
      }
    }

    return { tags, masterList, simpleSegList, segMusic, playMusic };
  },

  /**
   * Retrieves the ID3 data from an MP3. Currently only works on MP3s specifically.
   * @param sourceFile The MP3 file from which the tags will be retrieved.
   * @param showDate Optional. The date the episode aired, used for new track calculation. Otherwise, the current date is used.
   */
  FetchExternalTags: (sourceFile: string, showDate?: DateTime): AlternateData => {
    if (!fs.existsSync(sourceFile))
      throw new Error(`Source file ${sourceFile} does not exist`);

    if (sourceFile.substr(-4).localeCompare('.mp3', 'en', { sensitivity: 'accent' }))
      throw new Error(`Source file ${sourceFile} is not MP3 (only MP3s are currently supported)`);

    const getUserVal = (sourceTags: Tags, targetVal: string): string | null => {
      if (!sourceTags || !sourceTags.userDefinedText) return null;
      const udt = sourceTags.userDefinedText;
      for (let x in udt) {
        if (!udt[x].description) continue;
        if (!udt[x].description.localeCompare(targetVal, 'en', { sensitivity: 'accent' }))
          return udt[x].value;
      }
      return null;
    }

    const sourceTags = id3.read(sourceFile);
    const { language } = sourceTags;
    const CanCon = getUserVal(sourceTags, 'CanCon') ?? false;
    const hasLyrics = getUserVal(sourceTags, 'HasLyrics') ?? false;

    let newSong = false;
    const { releaseDate } = sourceTags;
    if (releaseDate) try {
      const trackAge = DateTime.fromISO(releaseDate).diff(showDate ?? DateTime.local());
      newSong = trackAge.months < CKDU_NEWTRACK_MAXMONTHS;
    } catch (e) {
      econsole.warn(`Possible invalid format trying to parse "${releaseDate}" as ISO string (for ${sourceFile})`);
    }

    return {
      type: DataType.Music,
      artist: sourceTags.artist,
      songTitle: sourceTags.title,
      album: sourceTags.album,
      image: sourceTags.image,
      CanCon: (Boolean(CanCon) === true && CanCon !== 'false'),
      songUrl: sourceTags.fileUrl ?? (sourceTags.artistUrl ? sourceTags.artistUrl[0] : undefined),
      tracker: {
        crtc: 21,
        newSong,
        language,
        hasLyrics: (Boolean(hasLyrics) === true && hasLyrics !== 'false')
      }
    };
  },

  /**
   * Generates the end credits spiel for this episode.
   * @async
   * @param data The episode's data.
   * @param param1 The input for this function.
   * @returns A promise which resolves into a string containing the end credits spiel.
   */
  GenerateEndCredits: async (data: ShowData, { simpleSegList, segMusic }: GenerateCompanionOptions): Promise<string> => {
    const { credits } = sqsyCompanion;
    let retval = [];
    let credited: Record<string, boolean> = {};

    if (!data.nonstandardEpisode) retval.push(credits.start);
    for (const seg of simpleSegList) if (credits[seg] && !credited[seg]) {
      retval.push(credits[seg]);
      credited[seg] = true;
    }

    let segArtists = segMusic.map(i => i.artist === 'KewlioMZX' ? 'myself' : i.artist);
    segArtists.push('and ' + segArtists.pop());
    retval.push(format(credits.segmusic, segArtists.join(segArtists.length > 2 ? ', ' : ' ')));

    if (data.nextOnCKDU) {
      let nextData = [];
      for (const timeslot in data.nextOnCKDU) nextData.push(data.nextOnCKDU[timeslot], timeslot);
      retval.push(format(credits.nextOnCKDU, ...nextData));
    }

    retval.push(credits.end);
    return retval.join('\n\n');
  },

  /**
   * Generates the long description for this episode's podcast entry.
   * @async
   * @param data The episode's data.
   * @param param1 The input for this function.
   * @returns A promise which resolves into the long description for the episode.
   */
  GenerateLongDescription: async (data: ShowData, { simpleSegList, segMusic, playMusic }: GenerateCompanionOptions): Promise<string> => {
    const { longdesc } = sqsyCompanion;
    let retval: (string | null)[] = [], guests: string[] | null = null;
    let credited: Record<string, boolean> = {};

    if (data.airdate) retval.push(format(longdesc.airdate, data.airdate.replace(/\d+,/, makeOrdinal)));
    retval.push(data.description);

    if (data.guest) {
      guests = ['<ul>'];
      retval.push('This episode\'s 🎙guests/🔊mentions:', null);

      for (let guest in data.guest) {
        let guestObj = data.guest[guest];
        const { links } = guestObj;
        let guestline = [];

        for (let linkname in links) {
          let dest = links[linkname], url = '';

          if (/^https?:\/\//.test(dest)) url = dest;
          else switch (linkname) {
            case 'SoundCloud':
              url = `https://soundcloud.com/${dest}`;
              break;
            case 'Bandcamp':
              url = `https://${dest}.bandcamp.com/`;
              break;
            case 'YouTube':
              url = `https://youtube.com/channel/${dest}`;
              break;
            case 'Twitter':
              url = `https://twitter.com/${dest}`;
              break;
            case 'Twitch':
              url = `https://twitch.tv/${dest}`;
              break;
            case 'Facebook':
              url = `https://facebook.com/${dest}`;
              break;
            case 'Instagram':
              url = `https://instagram.com/${dest}`;
              break;
            case 'Linktree':
              url = `https://linktr.ee/${dest}`;
              break;
            /*
            case '':
              url = `https://www.com/${dest}`;
              break;
            */

            default: url = `http://${dest}`; break;
          }
          if (url && url !== '') guestline.push(`<a href="${url}">${linkname}</a>`);
        }

        guests.push(`<li>${guestObj._guest ? '🎙' : '🔊'} ${guest}: ` + guestline.join(' ') + '</li>');
      }

      guests.push('</ul>');
    }

    if (!data.nonstandardEpisode) retval.push(longdesc.start);
    for (let seg of simpleSegList) if (longdesc[seg] && !credited[seg]) {
      if (seg === 'gnm') {
        /*let year = data.chapters.reduce((r, i) => {
          if (i.type != 'seg' || i.segType != 'gnm') return r;
          return item.title.replace(/[^\d]/g, '');
        }, data.year);*/
        retval.push(format(longdesc.gnm, data.year));
      }
      else retval.push(longdesc[seg]);
      credited[seg] = true;
    }

    retval.push('Playlist is as follows:', null, 'Segment music is as follows:', null, longdesc.end1);
    let twitch = data.twitchSimulcast ? longdesc.twitch : '';
    retval.push(format(longdesc.end2, twitch));

    let playlists = [];
    for (let playlist of [playMusic, segMusic]) {
      if (!playlist) continue;
      let listing = ['<ul>'];
      for (let tune of playlist) {
        let musicItem = `${tune.artist} - ${tune.songTitle}`;
        if (tune.album) musicItem += ` [${tune.album}]`;
        if (tune.songUrl) musicItem = `<a href="${tune.songUrl}">${musicItem}</a>`;
        if (tune.CanCon) musicItem += ' 🍁';
        listing.push(`<li>${musicItem}</li>`);
      }
      listing.push('</ul>');
      playlists.push(listing);
    }

    retval = retval.map(i => i ? `<p>${i}</p>` : i);
    if (guests && retval.indexOf(null) >= 0) retval.splice(retval.indexOf(null), 1, ...guests);
    for (let playlist = playlists.shift(); playlist; playlist = playlists.shift())
      retval.indexOf(null) >= 0 ? retval.splice(retval.indexOf(null), 1, ...playlist) : (playlists = []);
    return retval.join('\n');
  },

  /**
   * Generates the stream playlist to be used on the Twitch overlay.
   * @async
   * @param data The episode's data.
   * @param masterList Alternate data for all tracks used in this episode.
   * @returns A promise which resolves into the Twitch overlay playlist data.
   */
  GenerateStreamPlaylist: async (data: ShowData, masterList: AlternateData[]): Promise<string> => {
    let retval = [];

    for (let item of masterList) {
      let line = [];

      type createImageOptions = { artist: string; image: ImageData; };
      const createImage = ({ artist, image }: createImageOptions) => {
        artist = artist.replace(/\s/g, '-');
        if (!fs.existsSync(`${BASE_DATAPATH}Mus/${data.season}/`) ||
          !fs.existsSync(`${BASE_DATAPATH}Mus/${data.season}/${data.episode}/`))
          fs.mkdirSync(`${BASE_DATAPATH}Mus/${data.season}/${data.episode}`, { recursive: true });
        // TODO: extract image, resize to 100x100, save to overlay resource dir
        return `./Mus/${data.season}/${data.episode}/${artist}-100.png`;
      };

      switch (item.type) {
        case DataType.Music:
          line.push(...(item.archives ? ['Archives Music', './Seg/archives.png'] : ['Music', './Mus/Seg/genericmusic.jpg']));
          line.push(item.displaySong ?? `${item.artist}~~${item.songTitle}`);
          if (!item.image) line.push('./Mus/Seg/genericmusic.jpg');
          else if (typeof item.image == 'string') line.push(item.image);
          else line.push(createImage({ artist: item.artist ?? 'Unknown', image: item.image }));
          break;
        default:
          line.push(item.displayTitle ?? item.title, item.image ?? './Seg/sqsy.png', item.displaySong ?? `${item.artist}~~${item.songTitle}`);
          if (!item.image) line.push('./Mus/Seg/genericmusic.jpg');
          else if (typeof item.songImage == 'string') line.push(item.songImage);
          else line.push(createImage({ artist: item.artist ?? 'Unknown', image: item.songImage }));
          break;
      }

      retval.push(line.join('|'));
    }

    retval.push('');
    return retval.join('\n');
  },

  /**
   * Uploads the podcast episode to the Podcast Generator feed.
   * @async
   * @param data The episode's data.
   * @param browser The Puppeteer browser instance.
   * @returns A promise which resolves into void once the operation has completed.
   */
  UploadPodcastEpisode: async (data: ShowData, browser: Browser): Promise<void> => {
    const { podcast } = require('./SquareSymTypes/login.json');
    const { waitOnSignal } = Orchestrator;
    const page = await browser.newPage();
    let done = false;

    econsole.info('Podcast: Navigating to admin page...');
    await page.goto('https://lowbiasgaming.net/squaresym/?p=admin');
    while (!done) {
      let timeout = 30000;
      let target = null;
      let url = page.url();
      url = url.substr(url.indexOf('//') + 2);

      switch (true) {
        // We're done
        case url.startsWith('lowbiasgaming.net/squaresym/?p=admin&do=upload&c='):
          await page.screenshot({ path: 'podcastdone.png', fullPage: true });
          econsole.info('Podcast: Done.');
          break;

        // Upload episode
        case url.startsWith('lowbiasgaming.net/squaresym/?p=admin&do=upload'): {
          // Get controls
          const [file, title, shortDesc, category, longDescSrcBtn, keywords, upload] = await Promise.all([
            page.$('input#userfile'),
            page.$('input#title'),
            page.$('input#description'),
            page.$('select#category'),
            page.$('button[aria-label="Source code"]'),
            page.$('input[name=keywords]'),
            page.$('input[type=submit]'),
          ]);
          const [pubDay, pubMonth, pubYear, pubHour, pubMinute] = await page.$$('select.input-sm');
          const [explicit] = await page.$$('input[name=explicit]');

          // Provide location of output file
          const uploadFile = waitOnSignal('mp3tag')
            .then((location: string) => file && file.uploadFile(location));

          econsole.info('Podcast: Populating form...');
          // Fill in title and show description
          if (title) await title.type((data.season === 'SP' ? 'SP' : `S${data.season.toString().padStart(2, '0')}E`) +
            `${data.episode.toString().padStart(2, '0')} - ${data.title}`);
          if (shortDesc) await shortDesc.type(data.description);

          // Select categories
          let categoryList = [data.season === 'SP' ? 'specials' : `season_${data.season}`];
          if (data.categories) {
            if (data.categories.length > 2) categoryList = categoryList.concat(data.categories.slice(0, 2));
            else categoryList.concat(data.categories);
          }
          if (category) await category.select(...categoryList);

          // Fill in keywords
          let keywordList = ['chiptune', 'video games', 'community radio'];
          if (data.keywords) {
            if (data.keywords.length > 9) keywordList.splice(2, 0, ...data.keywords.slice(0, 9));
            else keywordList.splice(2, 0, ...data.keywords);
          }
          if (keywords) await keywords.type(keywordList.join(','));

          // Fill in post date
          let postDate = DateTime.fromFormat(data.airdate, 'DDD', { zone: 'America/Halifax' }).plus({ days: 2, hours: 17 });
          // Allow at least one hour from time of upload start before episode goes live
          if (postDate < DateTime.local().plus({ hours: 1 })) postDate = DateTime.local().plus({ hours: 1 });
          postDate = postDate.setZone('America/Chicago');

          await Promise.all([
            pubDay.select(postDate.day.toString()),
            pubMonth.select((postDate.month).toString()),
            pubYear.select(postDate.year.toString()),
            pubHour.select(postDate.hour.toString()),
            pubMinute.select(postDate.minute.toString().padStart(2, '0'))
          ]);

          // If explicit content, set the flag
          if (data.explicitLanguage) await explicit.click();

          // Fill in long description
          if (longDescSrcBtn) {
            await longDescSrcBtn.click();
            await page.waitForTimeout(200);
            const [longDescBox, longDescOk] = await Promise.all([
              page.$('textarea.tox-textarea'),
              page.$('button.tox-button[title=Save]')
            ]);
            if (longDescBox) await longDescBox.evaluate(
              (node: any, content: string) => node.value = content,
              (await waitOnSignal('companion')).longdesc as string
            );
            if (longDescOk) longDescOk.click();
            await page.waitForTimeout(200);
          }

          await uploadFile;

          // Screenshot for good measure
          await page.screenshot({ path: 'podcastform.png', fullPage: true });

          // If testing, don't upload
          //if (testMode) break;
          if (testOverride) break;

          // HEY KID, I'M A COMPUTER
          target = upload;
          timeout = 1800000;
          econsole.info('Podcast: Uploading episode (may take a while if the connection is throttled)...');
        } break;

        // Log in or admin menu
        case url.startsWith('lowbiasgaming.net/squaresym/?p=admin'): {
          // Get controls
          const [user, pw, button] = await Promise.all([
            page.$('#user'),
            page.$('#password'),
            page.$('input[type=submit]')
          ]);
          if (user) {
            // If there are login controls, then log in
            econsole.info('Podcast: Logging in...');

            await user.type(podcast.user);
            if (pw) await pw.type(podcast.pw);
            target = button;
          } else {
            // Otherwise, navigate to upload page
            econsole.info('Podcast: Navigating to upload page...');
            target = (await page.$x(`//a[contains(text(), 'Upload New Episode')]`)).shift();
          }
        } break;

        // Whoopsie doodle
        default:
          econsole.warn(`Podcast: Unknown location ${url}. Stopping.`);
          break;
      }
      if (target) await Promise.all([
        page.waitForNavigation({ timeout }),
        target.click()
      ]);
      else done = true;
    }

    econsole.info('Podcast finished.');
  },

  /**
   * Composes and saves the station log for CKDU logging purposes. Does not submit the log, as it should be reviewed manually first.
   * @param data The episode's data.
   * @param browser The Puppeteer browser instance.
   * @returns A promise which resolves into void once the operation has completed.
   */
  ComposeStationLog: async (data: ShowData, browser: Browser): Promise<void> => {
    const { logger } = require('./SquareSymTypes/login.json');
    const { waitOnSignal } = Orchestrator;
    const page = await browser.newPage();
    let done = false;

    econsole.info('Log: Navigating to admin page...');
    await page.goto('https://ckdu.ca/admin/');
    while (!done) {
      let url = page.url();
      let target = null;
      url = url.substr(url.indexOf('//') + 2);

      switch (true) {
        case url.startsWith('ckdu.ca/members/login'):
          econsole.info('Log: Logging in...');
          let [email, pw, button] = await Promise.all([
            page.$('#member_email'),
            page.$('#member_password'),
            page.$('input[type=submit]')
          ]);
          target = button;

          if (email) await email.type(logger.email);
          if (pw) await pw.type(logger.pw);
          break;

        case url.startsWith('ckdu.ca/admin/radio_logger/episodes/'):
          let [music, spoken, cart] = await page.$$('a.add_logger_fields');
          let save = await page.$('#save_and_continue_editing');

          if ((await page.$$('div.fields')).length > 0) {
            econsole.error('Log: Log not empty. Cannot proceed.');
            done = true;
            break;
          }

          const masterList = (await waitOnSignal('tags')).masterList as AlternateData[];

          econsole.info('Log: Populating show log...');
          for (const item of masterList) {
            switch (item.type) {
              case DataType.Segment:
                await music.click();
                await page.waitForTimeout(500);
                await spoken.click();
                break;
              case DataType.Music:
                await music.click();
                break;
              case DataType.Carts:
                await cart.click();
                break;
              default:
                econsole.warn(`Log: Unknown segment type '${item.type}'`);
                break;
            }
            await page.waitForTimeout(500);
          }

          econsole.info('Log: Writing show log...');
          let shiftList = masterList.slice();
          let readItem = shiftList.shift();
          for (const item of await page.$$('div.fields')) {
            if (!readItem) break;
            // What kind of log entry is this?
            const identifier = await item.$('div.field');
            const entryType = identifier ? (await identifier.getProperty('classList').then(r => r?.jsonValue()) as string[])[1] : '';

            switch (entryType) {
              case 'music': {
                // Get fields
                const [artist, title, album, language, SOCANTime] = await item.$$('input[type=text]');
                const crtc = await item.$('select');
                const [newSong, CanCon, instrumental/*, hit, stnLibrary*/] = await item.$$('input[type=checkbox]');
                const [SOCANTheme, SOCANBG, SOCANNeither] = await item.$$('input[type=radio]');

                // Fill in required fields
                await artist.type(readItem.artist ?? '');
                await title.type(readItem.songTitle ?? '');
                await album.type(readItem.album ?? 'Single');
                if (readItem.CanCon) await CanCon.click();
                if (readItem.tracker) {
                  if (crtc) await crtc.select(readItem.type === DataType.Music ? readItem.tracker.crtc.toString() : '21');
                  if (!readItem.tracker.hasLyrics) await instrumental.click();
                  if (readItem.tracker.newSong) await newSong.click();
                  if (readItem.tracker.language) {
                    await language.click({ clickCount: 3 });
                    await language.type(readItem.tracker.language);
                  }

                  // If SOCAN review period...
                  if (data.SOCAN && SOCANTime && readItem.tracker.SOCAN) {
                    // Fill in SOCAN fields
                    const { SOCAN } = readItem.tracker;
                    switch (SOCAN.type) {
                      case SOCANType.Theme: await SOCANTheme.click(); break;
                      case SOCANType.Background: await SOCANBG.click(); break;
                      case SOCANType.Neither: await SOCANNeither.click(); break;
                    }
                    await SOCANTime.type(SOCAN.time);
                  }
                }
              } break;
              case 'spoken': {
                // Get fields
                const [title, h, m, s/*, language*/] = await item.$$('input[type=text]');
                const crtc = await item.$('select');
                const localContent = await item.$('span.slider');
                const length = readItem.tracker && readItem.tracker.length ? readItem.tracker.length : Duration.fromObject({ seconds: 0 });

                // Fill in required fields
                await title.type(readItem.title ?? '');
                if (length.hours >= 1) h.type(length.hours.toString());
                if (length.minutes >= 1) await m.type(length.minutes.toString());
                if (length.seconds >= 1) await s.type(length.seconds.toString());
                if (localContent) await localContent.click();
                if (crtc && readItem.tracker) await crtc.select(readItem.tracker.crtc.toString());
              } break;
              case 'cart': {
                // Get fields
                const [title, timePlayed/*, language*/] = await item.$$('input[type=text]');
                const crtc = await item.$('select');

                // Fill in required fields
                await title.type(readItem.title ?? 'Carts');
                if (readItem.tracker) {
                  await timePlayed.type(readItem.tracker.timePlayed ?? '');
                  if (crtc) await crtc.select(readItem.tracker.crtc.toString());
                }
              } break;
              default:
                // Tim's done something >__>
                econsole.warn('Log: Unknown field type.');
                break;
            }
            if (!(entryType === 'music' && readItem.type === DataType.Segment)) readItem = shiftList.shift();
          }
          // Screenshot for good measure
          await page.screenshot({ path: 'showlog.png', fullPage: true });

          // If testing, don't save
          //if (testMode) break;
          if (testOverride) break;

          // Try to save
          await Promise.all([
            save && save.click(),
            page.waitForTimeout(1000)
          ]);

          // If there's a dialog, it didn't save; take a shot of the error
          if (await page.$('div.modal')) {
            econsole.error('Log: Error with show log. Please check screenshot. Log not saved.');
            await page.screenshot({ path: 'showlogerror.png', fullPage: true });
          }
          break;

        case url.startsWith('ckdu.ca/admin'):
          econsole.info('Log: Selecting log to fill...');
          let { airdate } = data;
          let airdate2 = DateTime.fromFormat(airdate, 'MMMM d, y').toFormat('MMMM dd, yyyy');
          target = (await page.$x(`//a[contains(text(), '${airdate}')]`)).shift();
          if (!target && airdate !== airdate2) target = (await page.$x(`//a[contains(text(), '${airdate2}')]`)).shift();
          if (!target) econsole.warn(`Log: No log found for ${airdate2}. Was it a special, or have you already filled it?`);
          break;

        default:
          econsole.warn('Log: Unknown location. Stopping.');
          done = true;
          break;
      }

      if (target) await Promise.all([
        page.waitForNavigation(),
        target.click()
      ]);
      else done = true;
    }

    econsole.info('Log finished.');
  }

}

const ModSquareSym: React.FC = (props) => {
  let [waitMode, setWaitMode] = useState(false);
  let [error, setError] = useState<string | null>(null);

  let [showData, setShowData] = useState<string | null>(null);

  let [makeLog, setMakeLog] = useState(false);
  let [doUpload, setDoUpload] = useState(false);

  const onReaperInput = ({ currentTarget }: SyntheticEvent<HTMLInputElement, Event>) => {
    const { files } = currentTarget; if (!files) return;
    const item = files.item(0); if (!item) return;

    setWaitMode(true);
    ReaperReader.fromBlob(item)
      .then(reaperData => {
        console.debug(reaperData);
        return SquareSymOps.ReaperProcess(item.name, reaperData);
      })
      .then(() => {
        setError(null);
        setWaitMode(false);
      })
      .catch((e: Error) => {
        console.error(e);
        setError(e.message);
        setWaitMode(false);
      });
    currentTarget.value = '';
  }

  const doTheThing = async (inputfileObj: File | null) => {
    setWaitMode(true);

    const browser = (makeLog || (doUpload && inputfileObj))
      ? Puppet.launch({
        executablePath: process.env.REACT_APP_PUPPETEER_CHROME_PATH, // define .env file with REACT_APP_PUPPETEER_CHROME_PATH
        headless: !testOverride, slowMo: 25, defaultViewport: { width: 1350, height: 800 }
      })
      : undefined;

    return fsPromises.readFile(`${BASE_DATAPATH}${showData}`)
      .then(buffer => SquareSymOps.TagProcess(
        JSON.parse(buffer.toString('utf8')) as ShowData,
        { inputfileObj, makeLog, doUpload, browser }
      ))
      .then(async () => {
        setError(null);
        setWaitMode(false);
        Orchestrator.clearAllSignals();
        if (browser) (await browser).close();
      })
      .catch(async (e: Error) => {
        console.error(e);
        setError(e.message);
        setWaitMode(false);
        Orchestrator.clearAllSignals();
        SquareSymOps.running = false;
        if (browser) (await browser).close();
      });
  }

  const onPodcastInput = ({ currentTarget }: SyntheticEvent<HTMLInputElement, Event>) => {
    const { files } = currentTarget; if (!files) return;
    const inputfileObj = files.item(0); if (!inputfileObj) return;

    doTheThing(inputfileObj).then(() => currentTarget.value = '');
  }

  const onPodcastNoInput = () => {
    if (doUpload) econsole.warn('Warning: Podcast upload will not occur if no file is selected.');
    doTheThing(null);
  }

  const onOptionsChange = ({ currentTarget }: SyntheticEvent<HTMLInputElement, Event>) => {
    switch (currentTarget.name) {
      case 'MakeLog': setMakeLog(currentTarget.checked); break;
      case 'DoUpload': setDoUpload(currentTarget.checked); break;
    }
  }

  const onShowDataChange = ({ currentTarget }: SyntheticEvent<HTMLSelectElement, Event>) => {
    setShowData(currentTarget.value);
  }

  const readShowDataDir = () => {
    if (!fs.existsSync('./showdata') || !fs.existsSync('./showdata/SquareSym')) {
      if (showData) setShowData(null);
      return <>Show data folder not found!</>
    }

    let fileList = fs.readdirSync(BASE_DATAPATH, { withFileTypes: true })
      .filter(i => i.isFile())
      .map(i => i.name)
      .filter(i => !extname(i).localeCompare('.json'));

    if (fileList.length === 0) {
      if (showData) setShowData(null);
      return <>No show data available!</>
    }

    if (showData && !fileList.includes(showData)) setShowData(null);

    fileList.unshift('');
    return <select value={showData ?? ''} onChange={onShowDataChange}>
      {fileList.map(i => <option key={`showdataopt-${i ?? 'empty'}`} value={i}>{basename(i, '.json')}</option>)}
    </select>;
  }

  return waitMode ? <>Wait</> : <>
    {error ? <>Error: {error}<br /></> : ''}
    Select episode data for steps 2 and 3: {readShowDataDir()}<br />
    <ul>
      <li>
        Step 1: Convert RPP into ChapMap data<br />
        <input type='file' accept='.rpp' onInput={onReaperInput} />
      </li>
      <li>Step 2: Fill in the blanks (to be implemented)</li>
      <li>
        Step 3: Tag the episode (and related operations)<br />
        <label><input type='checkbox' name='MakeLog' checked={makeLog} onChange={onOptionsChange} /> Compose station log</label><br />
        <label><input type='checkbox' name='DoUpload' checked={doUpload} onChange={onOptionsChange} /> Upload to podcast feed</label><br />
        <input type='file' accept='.mp3' onInput={onPodcastInput} disabled={!showData} />{' or '}
        <button disabled={!showData} onClick={onPodcastNoInput}>Only generate companion data</button>
      </li>
    </ul>
  </>;
}

export default ModSquareSym;
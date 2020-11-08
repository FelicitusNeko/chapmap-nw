//import fs, { promises as fsPromises } from 'fs';
import { /*promisify,*/ format } from 'util';
import { basename } from 'path';

import React, { SyntheticEvent, useState } from 'react';
import id3, { Tags } from 'node-id3';
import { DateTime, Duration } from 'luxon';
import { Browser } from 'puppeteer';
import mp3duration from '@rocka/mp3-duration';
//import * as mm from "music-metadata";

import { ReaperReader } from '../../tools/ReaperReader';
import { ItemParser } from '../../tools/ItemParser';
import Orchestrator from '../../tools/Orchestrator';

import { DataType, SegmentType, SOCANType } from './SquareSymTypes/enums';
import { ShowData, /*ShowChapterData,*/ SegmentChapterData, MusicChapterData, CartChapterData, AlternateData } from './SquareSymTypes/interfaces';

const fs = require('fs');
const fsPromises = fs.promises;


// HACK: temporary until we come up with better output
const econsole = console;

const chapmanConst = require('./SquareSymTypes/companion.json');
type ChapterData = {
  elementID: string;
  startTimeMs: number;
  endTimeMs: number;
  tags: Tags;
}
type ImageData = Tags['image'];

const CKDU_NEWTRACK_MAXMONTHS = 6;

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

type TagProcessOptions = {
  inputfile: string;
  makeLog: boolean;
  doUpload: boolean;
  browser?: Browser;
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
  ReaperProcess: (inputFile: string) => Promise<void>;

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

  TagProcess: async (data, { inputfile, makeLog, doUpload, browser }) => {
    if (SquareSymOps.running) return;
    SquareSymOps.running = true;

    const { FindMusicPath, GenerateTags, ComposeStationLog, UploadPodcastEpisode,
      GenerateEndCredits, GenerateLongDescription, GenerateStreamPlaylist } = SquareSymOps;

    if (data.description.length > 255) throw new Error(`Description too long (${data.description.length} chars, max is 255)`);
    if (data.SOCAN) econsole.warn('This is a SOCAN episode. All segments except carts must contain SOCANTime field.')

    if (!inputfile) econsole.warn('No input file specified. Will not be tagging episode.');
    else if (!fs.existsSync(`./Work/${inputfile}`)) throw new Error('Input file does not exist');

    //let datestamp = moment(data.airdate, 'MMMM Do, YYYY').format('YYYYMMDD');
    let datestamp = DateTime.fromFormat(data.airdate, 'DDD').toFormat('yyyyMMdd');
    //const browser = (makeLog || doUpload) ? await puppet.launch({ headless: headless && !testMode, slowMo: 25, defaultViewport: { width: 1350, height: 800 } }) : null;
    const { sendSignal } = Orchestrator;
    const outputfile: string =
      (data.season === 'SP' ? `SP` : `S${data.season.toString().padStart(2, '0')}E`) +
      `${data.episode.toString().padStart(2, '0')} ${data.title}`;

    const logOperation = (makeLog && browser) ? ComposeStationLog(data, browser) : null;
    const uploadOperation = (doUpload && inputfile && browser) ? UploadPodcastEpisode(data, browser) : null;
    if (logOperation || uploadOperation) econsole.info('Starting automated browser operation(s)...');

    if (inputfile) {
      if (inputfile.localeCompare(outputfile, 'en', { sensitivity: 'accent' }) === 0)
        throw new Error('Input and output filenames are the same');
      if (fs.existsSync(`./Work/${outputfile}.mp3`)) fs.unlinkSync(`./Work/${outputfile}.mp3`);
    }
    const copyop = inputfile ? fsPromises.copyFile(`./Work/${inputfile}`, `./Work/${outputfile}.mp3`) : true;

    let length: Promise<number> = inputfile
      ? mp3duration(`./Work/${inputfile}`).then((duration: number) => duration * 1000)
      //? mm.parseFile(`./Work/${inputfile}`, { duration: true }).then(data => data.format.duration ? data.format.duration * 1000 : 3300000)
      : Promise.resolve(3300000);

    econsole.info('Finding music path...');
    const musicPath = FindMusicPath(data, datestamp);
    sendSignal('musicPath');

    econsole.info('Generating tags...');
    let { tags, masterList, simpleSegList, segMusic, playMusic } = GenerateTags(data, { outputfile, length, musicPath });
    sendSignal('tags', { tags, masterList, simpleSegList, segMusic, playMusic });
    //econsole.debug(masterList);

    const tagOperation = inputfile ? (async () => {
      econsole.info('Waiting for audio length...');
      tags.length = (await length).toString();
      for (let chap of tags.chapter!) if (chap.endTimeMs < 0) chap.endTimeMs = await length;
      sendSignal('length', tags.length);

      econsole.info('Waiting for copy operation...');
      await copyop;
      sendSignal('copy');

      econsole.info('Writing tags to MP3...');
      id3.write(tags, `./Work/${outputfile}.mp3`);
      sendSignal('mp3tag', `./Work/${outputfile}.mp3`);
    })() : null;

    const companionOperation = (async () => {
      econsole.info('Generating companion data...');
      let credits: Promise<string> = GenerateEndCredits(data, { simpleSegList, segMusic });
      let longdesc: Promise<string> = GenerateLongDescription(data, { simpleSegList, segMusic, playMusic });
      let streamPL: Promise<string> = GenerateStreamPlaylist(data, masterList);

      econsole.info('Writing companion data...');
      fs.writeFileSync(`./Work/${outputfile}.credits.txt`, await credits);
      fs.writeFileSync(`./Work/${outputfile}.longdesc.txt`, await longdesc);
      fs.writeFileSync('./Work/playlist.txt', await streamPL);
      sendSignal('companion', { credits: await credits, longdesc: await longdesc, streamPL: await streamPL });
    })();

    //if (logOperation || uploadOperation) {
    //econsole.info('Waiting for async operations to finish...');
    await Promise.all([logOperation, uploadOperation, tagOperation, companionOperation]);
    //}

    if (browser) {
      econsole.info('Closing automated browser...');
      await browser.close();
    }

    econsole.info('Done.');
    let songsPlayed = segMusic.length + playMusic.length;
    let CanConAmount = masterList.reduce((r, i) => i.CanCon ? ++r : r, 0), CanConRate = Math.round(CanConAmount / songsPlayed * 1000) / 10;
    econsole.info(`CanCon rate: ${CanConAmount}/${songsPlayed} (${CanConRate}%)`);
    const CanConTarget = data.SOCAN ? 40 : 12;
    if (CanConRate < CanConTarget) econsole.warn(`WARNING: CanCon rate is under ${CanConTarget}%; consider changing music`);


  },//)().catch(err => { econsole.error(err); process.exit(1); });

  ReaperProcess: async (inputfile: string) => {
    const reaperData = new ReaperReader(inputfile);
    //const showDate = moment(basename(inputfile).substr(0, 8), 'YYYYMMDD');
    const showDate = DateTime.fromFormat(basename(inputfile).substr(0, 8), 'yMMdd');
    let retval: ShowData = {
      title: basename(inputfile, '.rpp').substr(9),
      season: 0,
      episode: 0,
      year: (new Date()).getFullYear(),
      airdate: showDate.toFormat('DDD'),
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
        let newSeg: SegmentChapterData = {
          type: DataType.Segment,
          start: Math.round(i.start * 1000)
        }

        switch (true) {
          case i.name.startsWith('SEG 00'):
            newSeg.segType = SegmentType.GoCall;
            newSeg.contentLength = Duration.fromObject({ seconds: Math.round(i.length) }).toISO();
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
            break;
          case i.name.startsWith('SEG 98'):
            // This is actually to be listed as a cart
            break;
          case i.name.startsWith('SEG 99'):
            newSeg.segType = SegmentType.LeadOut;
            break;
        }

        if (!newSeg.contentLength) newSeg.contentLength = Duration.fromObject({
          seconds: Math.round(
            voiceItems.filter(ii =>
              ii.start > i.start && ii.start < i.end
            ).reduce((r, i) => r + i.length, 0)
          )
        }).toISO();

        retval.chapters.push(newSeg);
      } else if (i.name.startsWith('SEGLOOP ')) {
        // probably do nothing? maybe revise some numbers
      } else {
        let newTrack: MusicChapterData = {
          type: DataType.Music,
          start: Math.round(i.start * 1000),
          from: i.source
        };
        retval.chapters.push(newTrack);
      }
    });
  },

  /**
   * Locates the base path where the music and data files will be located for this episode.
   * @param data The episode's data.
   * @param datestamp The datestamp for this episode.
   */
  FindMusicPath: (data: ShowData, datestamp: string | any[]) => {
    /*
    let dirs = fs.readdirSync(`./S${data.season}/`, { withFileTypes: true })
      .filter(i => i.isDirectory() && i.name.substr(0, data.season.toString().length) === data.season)
      .map(i => i.name);

    for (let dir of dirs) {
      let subdirs = fs.readdirSync(`./S${data.season}/${dir}/`, { withFileTypes: true })
        .filter(i => i.isDirectory && i.name.substr(0, datestamp.length) === `${datestamp}` && i.name.includes(data.title))
        .map(i => i.name);
      if (subdirs.length > 0) return `./S${data.season}/${dir}/${subdirs[0]}/`;
    }
    */

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
      length: '0',
      year: data.year.toString(),
      originalFilename: `${outputfile}.mp3`,
      image: './Seg/_mainlogo.png',
      chapter: []
    };

    let simpleSegList: string[] = [];
    let masterList: AlternateData[] = [];
    let segMusic: AlternateData[] = [];
    let playMusic: AlternateData[] = [];

    let lastStartPos: number = 72000000; // 2 hours
    for (let chap of data.chapters.slice().reverse()) {
      if (typeof chap.start == 'string') {
        chap.start = Duration.fromISO(chap.start).milliseconds;
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
      //else chap.endTimeMs = length;
      else chap.endTimeMs = -1;

      let altData: AlternateData = { type: item.type };
      switch (item.type) {
        case DataType.Segment:
          let sItem = item as SegmentChapterData;
          simpleSegList.push(sItem.segType!);
          chap.tags.image = './Seg/sqsy.png';
          switch (sItem.segType) {
            case SegmentType.GoCall:
              chap.tags.title = 'Opening bumper';
              break;

            case SegmentType.Intro:
              chap.tags.title = 'Intro & What\'s New at LowBiasGaming';
              url = 'https://lowbiasgaming.net/';
              altData = Object.assign(altData, {
                artist: 'KewlioMZX',
                songTitle: 'Heat Wave',
                songImage: './Seg/sqsy.png',
                CanCon: true,
                songUrl: 'https://kewliomzx.bandcamp.com/'
              });
              break;

            case SegmentType.FromTheArchives:
              chap.tags.title = `From the Archives: ${sItem.game}`;
              chap.tags.image = './Seg/Archives.png';
              if (sItem.gameId) url = `https://lowbiasgaming.net/playlist.php?gameid=${sItem.gameId}`;

              altData = Object.assign(altData, {
                displayTitle: `From the Archives~~${sItem.game}`,
                artist: 'Manabu Namiki, Noriyuki Kamikura',
                songTitle: 'Gentle Breeze',
                displaySong: 'M.Namiki, N.Kamikura~~Gentle Breeze',
                album: 'Trauma Center 2: Under the Knife OST',
                songImage: './Mus/Seg/archives-breeze.jpg'
              });
              break;

            case SegmentType.NewsOfTheWeird:
              chap.tags.title = 'News of the Weird';
              chap.tags.image = './Seg/notw.png';
              if (sItem.guest) chap.tags.title += ` w/ ${sItem.guest}`;
              if (sItem.weather) chap.tags.title += ' & Halifax Weather';
              if (sItem.newsDate) url = `https://uexpress.com/news-of-the-weird/${sItem.newsDate}`;

              altData = Object.assign(altData, {
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
              chap.tags.image = './Seg/review.png';

              altData = Object.assign(altData, {
                displayTitle: `Review~~${item.displayTitle ?? item.title}`,
                artist: 'Nifflas',
                songTitle: 'An Underwater Adventure (Mix B)'
              });
              break;

            case SegmentType.IFoundAThing:
              chap.tags.title = `I Found a Thing: ${item.title}`;
              chap.tags.image = './Seg/foundthing.png';

              altData = Object.assign(altData, {
                displayTitle: `I Found a Thing~~${item.displayTitle ?? item.title}`,
                artist: 'Pink Projects',
                songTitle: 'alloy_run'
              });
              break;

            case SegmentType.GamingNextMonth:
              chap.tags.title = `Gaming Next Month: ${item.title}`;
              chap.tags.image = './Seg/gnm.png';
              url = `https://gameinformer.com/${item.title!.replace(/[^\d]/g, '')}`;

              altData = Object.assign(altData, {
                displayTitle: `Gaming Next Month~~${item.title}`,
                artist: 'Shawn Daley',
                songTitle: 'Level 66',
                songImage: './Mus/Seg/gnm-level66.png',
                CanCon: true,
                songUrl: 'https://shawndaley.ca/'
              });
              break;

            case SegmentType.RapidReview:
              chap.tags.title = `Rapid Review Rampage: ${item.title}`;
              chap.tags.image = './Seg/review.png';

              altData = Object.assign(altData, {
                displayTitle: `Rapid Review Rampage~~${item.displayTitle ?? item.title}`,
                artist: 'zandax',
                songTitle: 'central park'
              });
              break;

            case SegmentType.Introspective:
              chap.tags.title = `Introspective: ${item.title}`;
              chap.tags.image = './Seg/introspective.png';

              altData = Object.assign(altData, {
                displayTitle: `Introspective~~${item.displayTitle ?? item.title}`,
                artist: 'Gigandect',
                songTitle: 'Dolphins are alright',
                songImage: './Mus/Seg/is-dolphins.jpg'
              });
              break;

            case SegmentType.Interview:
              // TODO: Interview pic
              chap.tags.title = `Interview: ${item.title}`;
              //chap.tags.image = './Seg/review.png';

              altData = Object.assign(altData, {
                displayTitle: `Interview~~${item.displayTitle ?? item.title}`,
                artist: 'whalebone',
                songTitle: 'double trouble'
              });
              break;

            case SegmentType.VGin10Minutes:
              chap.tags.title = `Video Games in 10 Minutes or Less: ${sItem.game}`;

              altData = Object.assign(altData, {
                displayTitle: `VG in 10 Minutes or Less~~${item.displayTitle ?? sItem.game}`,
                artist: 'Reverb',
                songTitle: 'altar_of_light'
              });
              break;

            case SegmentType.VGHistory:
              chap.tags.title = `Video Game History: ${item.title}`;

              altData = Object.assign(altData, {
                displayTitle: item.displayTitle ?? `Video Game History~~${item.title}`,
                artist: 'CHIBINOIZE',
                songTitle: 'Neon Lights',
                songImage: './Mus/Seg/is-dolphins.jpg'
              });
              break;

            case SegmentType.DialogBox:
              chap.tags.title = `The Dialog Box w/ ${sItem.guest}`;
              chap.tags.image = './Seg/dialogbox.png';

              altData = Object.assign(altData, {
                displayTitle: `The Dialog Box~~w/ ${sItem.guest}`,
                artist: 'Jarkko Virtanen',
                songTitle: 'alva usa kicknose'
              });
              break;

            case SegmentType.Miscellaneous:
              chap.tags.title = `Miscellaneous: ${item.title}`;

              altData = Object.assign(altData, {
                displayTitle: `Miscellaneous~~${item.title}`,
                artist: 'Yerzmyey',
                songTitle: 'Cybernetic Celtic Wizard'
              });
              break;

            case SegmentType.LeadOut:
              chap.tags.title = 'Lead-out';
              url = 'https://lowbiasgaming.net/squaresym';

              altData = Object.assign(altData, {
                displayTitle: `Lead-out`,
                artist: 'Kommisar',
                songTitle: 'Cherry Cola',
                CanCon: true,
                songUrl: 'https://soundcloud.com/kommisar/',
                songImage: './Mus/Seg/out-cherrycola.jpg'
              });
              break;

            default:
              chap.tags.title = item.title ?? `Undefined segment ${sItem.segType}`;
              altData = Object.assign(altData, {
                artist: sItem.artist,
                songTitle: sItem.songTitle,
                album: sItem.album,
                CanCon: sItem.CanCon
              });
              break;
          }
          if (!altData.tracker) altData.tracker = { crtc: 12 };
          //altData.tracker.length = moment.duration(sItem.contentLength, 'seconds');
          altData.tracker.length = Duration.fromISO(sItem.contentLength!);
          break;

        case DataType.Music:
          let mItem = item as MusicChapterData;
          if (mItem.from && !musicPath) throw new Error(`Can't use tag source ${mItem.from}; No music path found for episode`);
          altData = Object.assign(altData, mItem.from ? FetchExternalTags(`${musicPath}${mItem.from}`) : {
            artist: mItem.artist,
            songTitle: mItem.title,
            album: mItem.album,
            CanCon: mItem.CanCon,
            image: chap.tags.image,
            tracker: { crtc: item.crtc ?? 21 }
          });
          if (altData.artist) altData.artist = altData.artist.replace(/﻿/g, ', ');
          altData.archives = mItem.archives;
          if (!altData.tracker) altData.tracker = { crtc: item.crtc ?? 21 };
          if (mItem.hasLyrics) altData.tracker.hasLyrics = mItem.hasLyrics;
          if (mItem.newSong) altData.tracker.newSong = mItem.newSong;
          if (item.displaySong) altData.displaySong = item.displaySong;

          chap.tags.title = `${altData.artist} - ${altData.songTitle}`;
          if (altData.album) chap.tags.title += ` [${altData.album}]`;
          if (altData.CanCon) chap.tags.title += ' 🍁';
          if (altData.songUrl) url = altData.songUrl;
          else if (url) altData.songUrl = url;
          if (altData.image) {
            if (altData.image instanceof Object) chap.tags.image = altData.image;
            else chap.tags.image = altData.image = `./Mus/${data.season}/${data.episode}/${altData.image}`;
          }

          playMusic.push(altData);
          break;

        case DataType.Carts:
          let cItem = item as CartChapterData;
          cartCount++;
          altData = Object.assign(altData, {
            title: item.title ?? 'Carts',
            displayTitle: 'Station Break',
            image: './Seg/carts.png',
            displaySong: 'Station Break',
            songImage: './Seg/carts.png',
            tracker: { crtc: item.crtc ?? 51, timePlayed: cItem.estTime ?? '5:00 pm' }
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

          if (url) chap.tags.userDefinedUrl = [{ description: '**chapter url', url }];
          tags.chapter!.push(chap);

          altData.title = chap.tags.title;
          altData.image = chap.tags.image;
          if (url) altData.url = url;
          if (!altData.songImage) altData.songImage = './Mus/Seg/genericmusic.jpg';
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
        //console.debug(udt[x].description, targetVal);
        if (!udt[x].description) continue;
        if (!udt[x].description.localeCompare(targetVal, 'en', { sensitivity: 'accent' }))
          return udt[x].value;
      }
      return null;
    }

    const sourceTags = id3.read(sourceFile);
    const { language } = sourceTags;
    const CanCon = getUserVal(sourceTags, 'CanCon') ?? false;
    const hasLyrics = getUserVal(sourceTags, 'CanCon') ?? false;

    let newSong = false;
    //const { TDRL } = sourceTags.raw;
    //const { releaseDate } = sourceTags;
    const releaseDate = '2009-03-01'; // HACK: Temporary while I get things situated
    if (releaseDate) try {
      const trackAge = DateTime.fromFormat(releaseDate, 'y-M-d').diff(showDate ?? DateTime.local());
      newSong = trackAge.months < CKDU_NEWTRACK_MAXMONTHS;
    } catch (e) {
      econsole.warn(`Possible invalid format trying to parse "${releaseDate}" as YYYY-MM-DD string (for ${sourceFile})`);
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
    const { credits } = chapmanConst;
    let retval = [];

    if (!data.nonstandardEpisode) retval.push(credits.start);
    for (const seg of simpleSegList) if (credits[seg]) retval.push(credits[seg]);

    let segArtists = segMusic.map(i => i.artist === 'KewlioMZX' ? 'myself' : i.artist);
    segArtists.push('and ' + segArtists.pop());
    retval.push(format(credits.segmusic, segArtists.join(segArtists.length > 2 ? ', ' : ' ')));

    if (data.nextOnCKDU) {
      let nextData = [];
      for (const timeslot in data.nextOnCKDU) nextData.push(data.nextOnCKDU[timeslot], timeslot);
      //nextData.splice(1, 1);
      retval.push(format(credits.nextOnCKDU, ...(nextData.slice(1))));
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
    //const { longdesc } = require('./res/chapman-const');
    const { longdesc } = chapmanConst;
    let retval: (string | null)[] = [], guests: string[] | null = null;

    if (data.airdate) retval.push(format(longdesc.airdate.replace(/\d+,/, makeOrdinal), data.airdate));
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
    for (let seg of simpleSegList) if (longdesc[seg]) {
      if (seg === 'gnm') {
        /*let year = data.chapters.reduce((r, i) => {
          if (i.type != 'seg' || i.segType != 'gnm') return r;
          return item.title.replace(/[^\d]/g, '');
        }, data.year);*/
        retval.push(format(longdesc.gnm, data.year));
      }
      else retval.push(longdesc[seg]);
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
        if (!fs.existsSync(`./Mus/${data.season}/`)) fs.mkdirSync(`./Mus/${data.season}`);
        if (!fs.existsSync(`./Mus/${data.season}/${data.episode}/`)) fs.mkdirSync(`./Mus/${data.season}/${data.episode}`);
        // TODO: extract image, resize to 100x100, save to overlay resource dir
        return `./Mus/${data.season}/${data.episode}/${artist}-100.png`;
      };

      switch (item.type) {
        case DataType.Music:
          line.push(...(item.archives ? ['Archives Music', './Seg/archives.png'] : ['Music', './Mus/Seg/genericmusic.jpg']));
          line.push(item.displaySong ?? `${item.artist}~~${item.songTitle}`);
          if (typeof item.image == 'string') line.push(item.image);
          else line.push(createImage({ artist: item.artist!, image: item.image }));
          break;
        default:
          line.push(item.displayTitle ?? item.title, item.image ?? './Seg/sqsy.png', item.displaySong ?? `${item.artist}~~${item.songTitle}`);
          if (typeof item.songImage == 'string') line.push(item.songImage);
          else line.push(createImage({ artist: item.artist!, image: item.songImage }));
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
            page.$('div[aria-label="Source code"] button'),
            page.$('input[name=keywords]'),
            page.$('input[type=submit]'),
          ]);
          const [pubDay, pubMonth, pubYear, pubHour, pubMinute] = await page.$$('select.input-sm');

          // Provide location of output file
          //await file.uploadFile((await waitOnSignal('mp3tag')) as string);
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
          //if (postDate.isBefore(moment().add(1, 'hour'))) postDate = moment().add(1, 'hour');
          if (postDate < DateTime.local().plus({ hours: 1 })) postDate = DateTime.local().plus({ hours: 1 });
          //postDate.subtract(2, 'hours'); // Atlantic → Central time
          postDate = postDate.setZone('America/Chicago');
          await Promise.all([
            pubDay.select(postDate.day.toString()),
            pubMonth.select((postDate.month).toString()),
            pubYear.select(postDate.year.toString()),
            pubHour.select(postDate.hour.toString()),
            pubMinute.select(postDate.minute.toString().padStart(2, '0'))
          ]);

          // Fill in long description
          if (longDescSrcBtn) {
            await longDescSrcBtn.click();
            await page.waitFor(1000);
            const [longDescBox, longDescOk] = await Promise.all([
              page.$('div[aria-label="Source code"] textarea'),
              page.$('div[aria-label="Source code"] div.mce-foot button')
            ]);
            if (longDescBox) await longDescBox.evaluate(
              (node: any, content: string) => node.value = content,
              (await waitOnSignal('companion')).longdesc as string
            );
            if (longDescOk) longDescOk.click();
            await page.waitFor(1000);
          }

          await uploadFile;

          // Screenshot for good measure
          await page.screenshot({ path: 'podcastform.png', fullPage: true });

          // If testing, don't upload
          //if (testMode) break;

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
                await page.waitFor(500);
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
            await page.waitFor(500);
          }

          econsole.info('Log: Writing show log...');
          let shiftList = masterList.slice();
          let readItem = shiftList.shift();
          for (const item of await page.$$('div.fields')) {
            if (!readItem) break;
            // What kind of log entry is this?
            const identifier = await item.$('div.field');
            const entryType = identifier ? (await identifier.getProperty('classList').then(r => r.jsonValue()) as string[])[1] : '';

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

          // Try to save
          await Promise.all([
            save && save.click(),
            page.waitFor(1000)
          ]);

          // If there's a dialog, it didn't save; take a shot of the error
          if (await page.$('div.modal')) {
            econsole.error('Log: Error with show log. Please check screenshot. Log not saved.');
            await page.screenshot({ path: 'showlogerror.png', fullPage: true });
          }
          break;

        case url.startsWith('ckdu.ca/admin'):
          econsole.info('Log: Selecting log to fill...');
          //let airdate = moment(data.airdate, 'MMMM Do, YYYY');
          let airdate = { data };
          target = (await page.$x(`//a[contains(text(), '${airdate}')]`)).shift();
          if (!target) econsole.warn(`Log: No log found for ${airdate}. Was it a special, or have you already filled it?`);
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
  //econsole.log(require('mp3-duration'));

  const onReaperSelect = ({ currentTarget }: SyntheticEvent<HTMLInputElement, Event>) => {
    console.log(currentTarget.files);
    setWaitMode(true);
  }

  const testMusicMetadataMeasure = () => {
    console.log(fs.statSync('20201023 Forward to the Past.mp3'));
    return;
    /*console.log('Start time: ', (new Date()).getTime());
    mm.parseFile('20201023 Forward to the Past.mp3', { duration: true })
      .then(data => {
        console.log('End time: ', (new Date()).getTime());
        console.log('Duration: ', data.format.duration);
      })*/
  }

  console.log(fs);

  return waitMode ? <>Wait</> : <ul>
    <li>
      Step 1: Convert RPP into ChapMap data<br />
      <input type='file' accept='.rpp' onSelect={onReaperSelect} />
    </li>
    <li>Step 2: Fill in the blanks</li>
    <li>Step 3: Tag the episode (and related operations)</li>
    <li><button onClick={testMusicMetadataMeasure}>Test <code>music-metadata</code></button></li>
  </ul>;
}

export default ModSquareSym;